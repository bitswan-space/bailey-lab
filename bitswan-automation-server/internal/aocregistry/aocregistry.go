package aocregistry

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var manifestTypes = []string{
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
}

// buildTag is the name CI gives every build: the year, the run, and the commit.
// It is the only tag worth resolving to, because it is the only one that never
// moves and the only one a server can report as the version it runs.
var buildTag = regexp.MustCompile(`^(\d{4})-(\d+)-git-([0-9a-f]+)$`)

type Client struct {
	Host string
	Key  string
	http *http.Client
}

func New(host, key string) *Client {
	return &Client{Host: strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://"), "/"),
		Key: key, http: &http.Client{Timeout: 30 * time.Second}}
}

func (c *Client) apiBase() string {
	if rest, found := strings.CutPrefix(c.Host, "registry."); found {
		return "https://api." + rest
	}
	return "https://" + c.Host
}

func (c *Client) token(repository string) (string, error) {
	url := fmt.Sprintf("%s/api/frontend/registry/token/?service=%s&scope=repository:%s:pull",
		c.apiBase(), c.Host, repository)
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	request.SetBasicAuth("licence", c.Key)
	response, err := c.http.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the AOC answered %s for a pull token on %s", response.Status, repository)
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.Token == "" {
		return "", fmt.Errorf("the AOC returned no pull token for %s", repository)
	}
	return body.Token, nil
}

func (c *Client) digest(token, repository, reference string) (string, error) {
	url := fmt.Sprintf("https://%s/v2/%s/manifests/%s", c.Host, repository, reference)
	request, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", strings.Join(manifestTypes, ", "))
	response, err := c.http.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s:%s answered %s", repository, reference, response.Status)
	}
	return response.Header.Get("Docker-Content-Digest"), nil
}

func (c *Client) tags(token, repository string) ([]string, error) {
	url := fmt.Sprintf("https://%s/v2/%s/tags/list?n=1000", c.Host, repository)
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("listing tags of %s answered %s", repository, response.Status)
	}
	var body struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Tags, nil
}

func BuildTagsNewestFirst(tags []string) []string {
	dated := []string{}
	for _, tag := range tags {
		if buildTag.MatchString(tag) {
			dated = append(dated, tag)
		}
	}
	sort.Slice(dated, func(i, j int) bool { return runNumber(dated[i]) > runNumber(dated[j]) })
	return dated
}

func runNumber(tag string) int {
	match := buildTag.FindStringSubmatch(tag)
	if match == nil {
		return 0
	}
	number, _ := strconv.Atoi(match[2])
	return number
}

// Resolve names the build that <repository>:latest currently points at, fully
// qualified for this registry.
//
// The moving tag is only ever used to find the build; what comes back names a
// build, so a server can say which one it runs and two servers on the same
// release cannot disagree about what that means.
func (c *Client) Resolve(repository string) (string, error) {
	token, err := c.token(repository)
	if err != nil {
		return "", err
	}
	wanted, err := c.digest(token, repository, "latest")
	if err != nil {
		return "", err
	}
	tags, err := c.tags(token, repository)
	if err != nil {
		return "", err
	}
	for _, tag := range BuildTagsNewestFirst(tags) {
		found, err := c.digest(token, repository, tag)
		if err != nil {
			continue
		}
		if found == wanted {
			return fmt.Sprintf("%s/%s:%s", c.Host, repository, tag), nil
		}
	}
	return "", fmt.Errorf("no build tag in %s points at the same image as :latest", repository)
}

// DockerLogin hands the key to Docker so the pulls themselves carry it.
func (c *Client) DockerLogin() error {
	command := exec.Command("docker", "login", c.Host, "-u", "licence", "--password-stdin")
	command.Stdin = strings.NewReader(c.Key)
	if out, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("docker login %s: %w: %s", c.Host, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Tags lists the builds of a repository, newest first.
//
// Only build tags: the moving ones say nothing about which build they point
// at, and offering them as choices is how an operator pins something that
// moves under them later.
func (c *Client) Tags(repository string) ([]string, error) {
	token, err := c.token(repository)
	if err != nil {
		return nil, err
	}
	tags, err := c.tags(token, repository)
	if err != nil {
		return nil, err
	}
	return BuildTagsNewestFirst(tags), nil
}

// Reference is a fully qualified name for one build in this registry.
func (c *Client) Reference(repository, tag string) string {
	return fmt.Sprintf("%s/%s:%s", c.Host, repository, tag)
}
