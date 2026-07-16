package dockerdriver

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Garage admin-plane helpers. Every control operation (keys, buckets, grants)
// runs as `docker exec <ws>__garage<suffix> /garage json-api <Endpoint> [json]`
// — the CLI invokes the admin API locally over the node's RPC, so no HTTP
// client, no admin token and no shell are needed (the image is a single
// static binary). Logs go to stderr, the JSON result to stdout.
//
// NEVER use ImportKey: Garage forbids custom key identifiers ("will break
// your Garage cluster") — access keys are always minted server-side by
// CreateKey, which is why the driver's credential flow is inverted relative
// to the old MinIO scheme (see bpcreds.go).

// garageJSONAPI execs one admin call and unmarshals its stdout into out
// (out == nil discards the result). body == "" sends no payload argument.
// Bodies never contain secrets (key material only ever comes BACK on stdout),
// so passing them as an argv element is safe.
func garageJSONAPI(ctx context.Context, container, endpoint, body string, out interface{}) error {
	args := []string{"/garage", "json-api", endpoint}
	if body != "" {
		args = append(args, body)
	}
	stdout, stderr, rc := dockerExec(ctx, container, args...)
	if rc != 0 {
		return fmt.Errorf("garage %s: %s", endpoint, strings.TrimSpace(stderr))
	}
	if out != nil {
		if err := json.Unmarshal([]byte(stdout), out); err != nil {
			return fmt.Errorf("garage %s: unmarshal response: %w", endpoint, err)
		}
	}
	return nil
}

// garageIsAlreadyExists / garageIsNotFound classify the admin API's error
// strings (relayed via stderr): "BucketAlreadyExists (409)" / "NoSuchBucket
// (404)". Matched loosely on the stable error-code token.
func garageIsAlreadyExists(err error) bool {
	return err != nil && strings.Contains(err.Error(), "BucketAlreadyExists")
}

func garageIsNotFound(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "NoSuchBucket") ||
		strings.Contains(err.Error(), "NoSuchKey") ||
		strings.Contains(err.Error(), "NoSuchAccessKey"))
}

// garageCreateKey mints a new access key (Garage generates both the GK… id
// and the secret) and returns them. `name` is a human label only.
func garageCreateKey(ctx context.Context, container, name string) (accessKeyID, secretAccessKey string, err error) {
	var resp struct {
		AccessKeyID     string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
	}
	body := fmt.Sprintf(`{"name":%q}`, name)
	if err := garageJSONAPI(ctx, container, "CreateKey", body, &resp); err != nil {
		return "", "", err
	}
	if resp.AccessKeyID == "" || resp.SecretAccessKey == "" {
		return "", "", fmt.Errorf("garage CreateKey %s: empty key material in response", name)
	}
	return resp.AccessKeyID, resp.SecretAccessKey, nil
}

// garageCreateBucket creates a bucket under a global alias and returns its id.
// Tolerates a concurrent/pre-existing bucket by resolving the alias instead.
func garageCreateBucket(ctx context.Context, container, alias string) (bucketID string, err error) {
	var resp struct {
		ID string `json:"id"`
	}
	body := fmt.Sprintf(`{"globalAlias":%q}`, alias)
	err = garageJSONAPI(ctx, container, "CreateBucket", body, &resp)
	if garageIsAlreadyExists(err) {
		return garageGetBucketID(ctx, container, alias)
	}
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}

// garageGetBucketID resolves a global alias to the bucket id.
func garageGetBucketID(ctx context.Context, container, alias string) (string, error) {
	var resp struct {
		ID string `json:"id"`
	}
	body := fmt.Sprintf(`{"globalAlias":%q}`, alias)
	if err := garageJSONAPI(ctx, container, "GetBucketInfo", body, &resp); err != nil {
		return "", err
	}
	return resp.ID, nil
}

// garageAllowBucketKey grants a key full access (read+write+owner) to one
// bucket. Idempotent — permissions OR together server-side.
func garageAllowBucketKey(ctx context.Context, container, bucketID, accessKeyID string) error {
	body := fmt.Sprintf(
		`{"bucketId":%q,"accessKeyId":%q,"permissions":{"read":true,"write":true,"owner":true}}`,
		bucketID, accessKeyID)
	return garageJSONAPI(ctx, container, "AllowBucketKey", body, nil)
}

// garageListBuckets returns globalAlias → bucketID for every bucket.
// Doubles as the provisioner's readiness probe (fails while the node boots).
func garageListBuckets(ctx context.Context, container string) (map[string]string, error) {
	var resp []struct {
		ID            string   `json:"id"`
		GlobalAliases []string `json:"globalAliases"`
	}
	if err := garageJSONAPI(ctx, container, "ListBuckets", "", &resp); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(resp))
	for _, b := range resp {
		for _, a := range b.GlobalAliases {
			out[a] = b.ID
		}
	}
	return out, nil
}

// garageListKeys returns the set of existing access-key ids.
func garageListKeys(ctx context.Context, container string) (map[string]bool, error) {
	var resp []struct {
		ID string `json:"id"`
	}
	if err := garageJSONAPI(ctx, container, "ListKeys", "", &resp); err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(resp))
	for _, k := range resp {
		out[k.ID] = true
	}
	return out, nil
}
