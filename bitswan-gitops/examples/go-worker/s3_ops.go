package main

import (
	"bytes"
	"context"
	"io"
	"log"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

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
	exists, err := mc.BucketExists(ctx, galleryBucket)
	if err != nil {
		log.Fatalf("checking bucket: %v", err)
	}
	if !exists {
		// gitops normally pre-creates the bucket; a scoped user may not be able
		// to create it, so don't make this fatal.
		if err := mc.MakeBucket(ctx, galleryBucket, minio.MakeBucketOptions{}); err != nil {
			log.Printf("warning: could not create bucket %s (expected if gitops provisions it): %v", galleryBucket, err)
		} else {
			log.Printf("created bucket: %s", galleryBucket)
		}
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
