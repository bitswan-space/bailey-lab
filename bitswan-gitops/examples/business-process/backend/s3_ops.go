package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// s3InitDeadline bounds the startup wait for this BP's S3 bucket + scoped
// key. Like the database, they are provisioned by the driver around the same
// time the worker starts — provisioning runs AFTER `docker compose up`, so the
// backend's first BucketExists legitimately fails with "Access Denied" until
// the scoped user exists. We retry until reachable instead of crash-exiting: a
// clean os.Exit(1) is NOT restarted by Air (live-dev), so a one-shot failure
// would leave the backend dead forever even though the user appears seconds
// later. Only after the deadline do we fail loudly. Mirrors dbInitDeadline.
const s3InitDeadline = 3 * time.Minute

// galleryBucket is the per-BP bucket injected by gitops as S3_BUCKET — no
// hardcoded bucket name. Empty (unset) is caught at startup in ensureBucket.
var galleryBucket = envOr("S3_BUCKET", "")

func mustInitS3() *minio.Client {
	host := envOr("S3_HOST", "localhost")
	endpoint := host + ":" + envOr("S3_PORT", "9000")
	// Scoped per-BP credentials (limited to this BP's bucket), Garage-issued
	// and injected by the driver; dev defaults for standalone runs.
	accessKey := envOr("S3_ACCESS_KEY", "minioadmin")
	secretKey := envOr("S3_SECRET_KEY", "minioadmin")

	// minio-go is used purely as an S3 client — the server is Garage, which
	// speaks S3 with s3_region us-east-1 (minio-go's default) and a clean
	// hyphenated hostname alias, so no region or Host workarounds are needed.
	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: false,
	})
	if err != nil {
		log.Fatalf("failed to create S3 client: %v", err)
	}
	return mc
}

func ensureBucket(mc *minio.Client) {
	if galleryBucket == "" {
		log.Fatal("S3_BUCKET is not set")
	}
	ctx := context.Background()
	// Retry BucketExists through the provisioning window (see s3InitDeadline).
	// "Access Denied" while the scoped user isn't created yet is the transient
	// error we ride out; a persistent one fails loudly after the deadline.
	deadline := time.Now().Add(s3InitDeadline)
	for attempt := 1; ; attempt++ {
		exists, err := mc.BucketExists(ctx, galleryBucket)
		if err == nil {
			if !exists {
				// gitops normally pre-creates the bucket; a scoped user may not be
				// able to create it, so don't make this fatal.
				if err := mc.MakeBucket(ctx, galleryBucket, minio.MakeBucketOptions{}); err != nil {
					log.Printf("warning: could not create bucket %s (expected if gitops provisions it): %v", galleryBucket, err)
				} else {
					log.Printf("created bucket: %s", galleryBucket)
				}
			}
			return
		}
		if time.Now().After(deadline) {
			log.Fatalf("s3 bucket %s not reachable after retrying for %s: %v", galleryBucket, s3InitDeadline, err)
		}
		log.Printf("object storage not ready (attempt %d): %v — retrying in 2s…", attempt, err)
		time.Sleep(2 * time.Second)
	}
}

func uploadFile(mc *minio.Client, key string, data []byte, contentType string) error {
	ctx := context.Background()
	_, err := mc.PutObject(ctx, galleryBucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType})
	return err
}

func getFile(mc *minio.Client, key string) ([]byte, string, error) {
	ctx := context.Background()
	obj, err := mc.GetObject(ctx, galleryBucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, "", err
	}
	defer obj.Close()

	info, err := obj.Stat()
	if err != nil {
		return nil, "", err
	}

	data, err := io.ReadAll(obj)
	if err != nil {
		return nil, "", err
	}
	return data, info.ContentType, nil
}

func deleteFile(mc *minio.Client, key string) error {
	ctx := context.Background()
	return mc.RemoveObject(ctx, galleryBucket, key, minio.RemoveObjectOptions{})
}
