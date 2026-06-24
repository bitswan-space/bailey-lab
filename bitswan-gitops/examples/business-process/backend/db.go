package main

import (
	"fmt"
	"log"
	"time"

	"backend/models"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// dbInitDeadline bounds the startup wait for the per-BP database. The database
// is provisioned around the same time the worker starts, and postgres can be
// (re)started by a deploy reconcile, so the first connection legitimately fails
// for a short window ("connection refused", "database ... does not exist", "the
// database system is shutting down"). We retry until reachable instead of
// crash-looping the container; only after the deadline do we fail loudly.
const dbInitDeadline = 3 * time.Minute

func mustInitDB() *gorm.DB {
	deadline := time.Now().Add(dbInitDeadline)
	for attempt := 1; ; attempt++ {
		db, err := initDBOnce()
		if err == nil {
			return db
		}
		if time.Now().After(deadline) {
			log.Fatalf("database not ready after retrying for %s: %v", dbInitDeadline, err)
		}
		log.Printf("database not ready (attempt %d): %v — retrying in 2s…", attempt, err)
		time.Sleep(2 * time.Second)
	}
}

// initDBOnce makes ONE full attempt to connect, verify, and migrate. Any error
// is returned (not fatal) so mustInitDB can retry it through the transient
// startup window above.
func initDBOnce() (*gorm.DB, error) {
	host := envOr("POSTGRES_HOST", "localhost")
	user := envOr("POSTGRES_USER", "admin")
	password := envOr("POSTGRES_PASSWORD", "")
	dbname := envOr("POSTGRES_DB", "postgres")
	port := envOr("POSTGRES_PORT", "5432")

	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		host, port, user, password, dbname)

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("sql.DB: %w", err)
	}
	// Force a real round-trip: gorm.Open is lazy, so without this a dead/absent
	// database wouldn't surface until the first query (mid-migrate).
	if err := sqlDB.Ping(); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}
	sqlDB.SetMaxOpenConns(5)

	if err := db.AutoMigrate(&models.UserCounter{}); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}

	// gallery_images is managed via raw idempotent DDL rather than
	// AutoMigrate. GORM's column-diff path keeps emitting an unconditional
	// `DROP CONSTRAINT uni_gallery_images_key` whenever it thinks the
	// column previously had a unique constraint, which aborts the whole
	// migration on databases where that constraint name never existed
	// (SQLSTATE 42704). Plain CREATE-IF-NOT-EXISTS sidesteps that.
	const galleryImagesDDL = `
	CREATE TABLE IF NOT EXISTS gallery_images (
		id           BIGSERIAL    PRIMARY KEY,
		key          TEXT         NOT NULL,
		title        TEXT         NOT NULL,
		content_type TEXT         NOT NULL,
		size         BIGINT       NOT NULL,
		uploaded_by  TEXT         NOT NULL,
		created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
	)`
	if err := db.Exec(galleryImagesDDL).Error; err != nil {
		return nil, fmt.Errorf("create gallery_images table: %w", err)
	}
	// Drop any leftover constraint/index from prior half-migrated states so
	// the table converges on a single uniqueness mechanism we control.
	db.Exec(`ALTER TABLE gallery_images DROP CONSTRAINT IF EXISTS uni_gallery_images_key`)
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_images_key ON gallery_images (key)`).Error; err != nil {
		return nil, fmt.Errorf("create gallery_images key index: %w", err)
	}

	return db, nil
}

func listGalleryImages(db *gorm.DB) ([]models.GalleryImage, error) {
	var images []models.GalleryImage
	err := db.Order("created_at desc").Find(&images).Error
	return images, err
}

func getCount(db *gorm.DB, username string) (int, error) {
	var counter models.UserCounter
	err := db.Where("username = ?", username).First(&counter).Error
	if err == gorm.ErrRecordNotFound {
		return 0, nil
	}
	return counter.Count, err
}

func incrementCount(db *gorm.DB, username string) (int, error) {
	var counter models.UserCounter
	err := db.Where("username = ?", username).First(&counter).Error
	if err == gorm.ErrRecordNotFound {
		counter = models.UserCounter{Username: username, Count: 1}
		if err := db.Create(&counter).Error; err != nil {
			return 0, err
		}
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	counter.Count++
	if err := db.Save(&counter).Error; err != nil {
		return 0, err
	}
	return counter.Count, nil
}

func insertGalleryImage(db *gorm.DB, key, title, contentType string, size int, uploadedBy string) (*models.GalleryImage, error) {
	img := &models.GalleryImage{
		Key:         key,
		Title:       title,
		ContentType: contentType,
		Size:        size,
		UploadedBy:  uploadedBy,
	}
	if err := db.Create(img).Error; err != nil {
		return nil, err
	}
	return img, nil
}

func deleteGalleryImage(db *gorm.DB, key string) error {
	result := db.Where("key = ?", key).Delete(&models.GalleryImage{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func galleryImageExists(db *gorm.DB, key string) bool {
	var count int64
	db.Model(&models.GalleryImage{}).Where("key = ?", key).Count(&count)
	return count > 0
}
