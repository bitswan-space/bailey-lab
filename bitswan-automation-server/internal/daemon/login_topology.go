package daemon

import (
	"fmt"
	"os"
)

func reconcileLoginTopology() error {
	domain := protectedHostnameDomain()
	if domain == "" {
		return fmt.Errorf("no domain configured — register with the AOC first")
	}

	if !ssoActive() {
		stopDex()
		removeDexRoute(domain)
		return provisionProtectedProxy()
	}

	sso, err := getSSOConfig()
	if err != nil {
		return err
	}

	secret, err := loadOrCreateDexProxySecret()
	if err != nil {
		return err
	}
	if err := writeDexConfig(domain, sso, secret); err != nil {
		return err
	}
	if err := startDex(); err != nil {
		return err
	}
	registerDexRoute(domain)

	return provisionProtectedProxy()
}

func loadOrCreateDexProxySecret() (string, error) {
	dir := dexConfigDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("create dex config directory: %w", err)
	}
	path := dir + "/proxy-client-secret"
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		return string(b), nil
	}
	secret, err := generateProxyCookieSecret()
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(secret), 0600); err != nil {
		return "", fmt.Errorf("write dex proxy client secret: %w", err)
	}
	return secret, nil
}
