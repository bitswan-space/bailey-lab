package aoc

import (
	"fmt"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// EnsureRegistryAccess makes sure this server holds credentials for the
// registry its AOC serves images from, and returns where and with what.
//
// The key is handed over once, so it is kept. Asking again for a server that
// already has one returns the host and no key, which is why a stored key is
// used rather than replaced. A server that lost its key asks for a rotation;
// that is the only way to get a second one, and it retires the first.
func EnsureRegistryAccess(rotate bool) (host, key string, err error) {
	store := config.NewAutomationServerConfig()
	settings, err := store.GetAutomationOperationsCenterSettings()
	if err != nil {
		return "", "", err
	}
	if settings.AOCUrl == "" || settings.AccessToken == "" {
		return "", "", fmt.Errorf("this server is not registered to an AOC")
	}
	if !rotate && settings.RegistryHost != "" && settings.RegistryKey != "" {
		return settings.RegistryHost, settings.RegistryKey, nil
	}

	client, err := NewAOCClientWithToken(settings.AOCUrl, settings.AutomationServerId, settings.AccessToken)
	if err != nil {
		return "", "", err
	}
	licence, err := client.GetLicence(rotate)
	if err != nil {
		return "", "", err
	}
	if licence.Registry.Host == "" {
		return "", "", fmt.Errorf("this AOC does not say which registry serves it")
	}

	updated := *settings
	updated.RegistryHost = licence.Registry.Host
	// An AOC that has issued this server a key before will not issue another,
	// so an empty key here means the one on disk is still the right one.
	if licence.Registry.Key != "" {
		updated.RegistryKey = licence.Registry.Key
	}
	if updated.RegistryKey == "" {
		return "", "", fmt.Errorf(
			"the AOC has already issued this server a key and will not repeat it; " +
				"rotate to get a new one")
	}
	if err := store.UpdateAutomationServer(updated); err != nil {
		return "", "", err
	}
	return updated.RegistryHost, updated.RegistryKey, nil
}
