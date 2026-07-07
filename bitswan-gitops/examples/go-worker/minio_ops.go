package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// galleryBucket is the per-BP bucket injected by gitops as MINIO_BUCKET — no
// hardcoded bucket name. Empty (unset) is caught at startup in ensureBucket.
var galleryBucket = envOr("MINIO_BUCKET", "")

func mustInitMinio() *minio.Client {
	host := envOr("MINIO_HOST", "localhost")

	// Docker hostnames with "__" are invalid per HTTP RFC, causing MinIO server
	// to reject the Host header. Resolve to IP to avoid this.
	if addrs, err := net.LookupHost(host); err == nil && len(addrs) > 0 {
		host = addrs[0]
	}

	endpoint := host + ":9000"
	// Scoped per-BP credentials (limited to this BP's bucket) — not the MinIO
	// root. gitops injects these; falls back to dev defaults for standalone runs.
	accessKey := envOr("MINIO_ACCESS_KEY", "minioadmin")
	secretKey := envOr("MINIO_SECRET_KEY", "minioadmin")

	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: false,
	})
	if err != nil {
		log.Fatalf("failed to create MinIO client: %v", err)
	}
	return mc
}

func ensureBucket(mc *minio.Client) {
	if galleryBucket == "" {
		log.Fatal("MINIO_BUCKET is not set")
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
