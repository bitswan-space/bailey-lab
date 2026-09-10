// Package k8sctl applies objects to the namespace this process runs in.
//
// It shells out to kubectl, which is the same choice the Docker driver makes
// about the docker CLI: the image carries the tool, the tool carries the
// protocol version, and this module's dependency list stays fifteen lines long.
// The alternative is an API client library whose transitive dependencies would
// outnumber everything else in the repository put together.
//
// Everything here is namespace-scoped and takes the namespace from the pod's own
// service account, so there is no call that can act outside it by accident.
package k8sctl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

const namespaceFile = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"

// Namespace is the namespace this process runs in.
func Namespace() (string, error) {
	if ns := strings.TrimSpace(os.Getenv("BITSWAN_K8S_NAMESPACE")); ns != "" {
		return ns, nil
	}
	b, err := os.ReadFile(namespaceFile)
	if err != nil {
		return "", fmt.Errorf("read own namespace: %w", err)
	}
	ns := strings.TrimSpace(string(b))
	if ns == "" {
		return "", fmt.Errorf("own namespace is empty")
	}
	return ns, nil
}

// Apply creates or updates every object, and prunes nothing: a caller that wants
// something gone says so.
func Apply(ctx context.Context, objs k8srender.ObjectSet) error {
	if len(objs) == 0 {
		return nil
	}
	ns, err := Namespace()
	if err != nil {
		return err
	}
	manifest, err := objs.Marshal()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "-n", ns, "apply", "-f", "-")
	cmd.Stdin = bytes.NewReader(manifest)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("kubectl apply: %w: %s", err, strings.TrimSpace(out.String()))
	}
	return nil
}

// WaitAvailable blocks until a Deployment has the replicas it asked for, or the
// timeout passes.
//
// The error carries the object's recent events, because "timed out waiting" on
// its own sends the reader to a terminal, and the reason is almost always in
// there: an image that cannot be pulled, a volume that will not bind, a pod no
// node will take.
func WaitAvailable(ctx context.Context, deployment string, timeout time.Duration) error {
	ns, err := Namespace()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "-n", ns, "rollout", "status",
		"deployment/"+deployment, "--timeout="+timeout.String())
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s did not become available: %w: %s\n%s",
			deployment, err, strings.TrimSpace(out.String()), describe(ctx, ns, deployment))
	}
	return nil
}

// Delete removes an object, and treats "already gone" as success.
func Delete(ctx context.Context, kind, name string) error {
	ns, err := Namespace()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "-n", ns, "delete", kind, name,
		"--ignore-not-found=true")
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("kubectl delete %s/%s: %w: %s", kind, name, err, strings.TrimSpace(out.String()))
	}
	return nil
}

// Available reports whether a Deployment has at least one ready replica. This is
// the namespace's answer to "is that container running?".
func Available(ctx context.Context, deployment string) bool {
	ns, err := Namespace()
	if err != nil {
		return false
	}
	out, err := exec.CommandContext(ctx, "kubectl", "-n", ns, "get",
		"deployment", deployment, "-o", "jsonpath={.status.readyReplicas}").Output()
	if err != nil {
		return false
	}
	ready := strings.TrimSpace(string(out))
	return ready != "" && ready != "0"
}

func describe(ctx context.Context, ns, deployment string) string {
	out, err := exec.CommandContext(ctx, "kubectl", "-n", ns, "get", "events",
		"--field-selector", "involvedObject.name="+deployment,
		"--sort-by=.lastTimestamp", "-o", "wide").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// PruneRetired deletes the workloads carrying `selector` that the caller did not
// just apply.
//
// This is what `compose up --remove-orphans` does for the Docker driver, scoped
// the same way: to one business process, so a deploy of one cannot reap a
// sibling's. Only Deployments and their Services are considered — a StatefulSet
// owns a volume, and nothing that owns data is removed by a deploy.
func PruneRetired(ctx context.Context, selector string, keep map[string]bool) error {
	ns, err := Namespace()
	if err != nil {
		return err
	}
	for _, kind := range []string{"deployment", "service", "secret"} {
		out, err := exec.CommandContext(ctx, "kubectl", "-n", ns, "get", kind,
			"-l", selector, "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}").Output()
		if err != nil {
			return fmt.Errorf("list %s to prune: %w", kind, err)
		}
		for _, name := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			name = strings.TrimSpace(name)
			if name == "" || keep[kind+"/"+name] {
				continue
			}
			if err := Delete(ctx, kind, name); err != nil {
				return err
			}
		}
	}
	return nil
}

// WaitRollout blocks until an object of any kind has finished rolling out.
//
// WaitAvailable's Deployment-only shape does not cover a StatefulSet, and a
// database is always a StatefulSet — so the one wait a deploy most needs before
// it provisions was the one that could not be expressed.
func WaitRollout(ctx context.Context, kind, name string, timeout time.Duration) error {
	ns, err := Namespace()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "-n", ns, "rollout", "status",
		strings.ToLower(kind)+"/"+name, "--timeout="+timeout.String())
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s/%s did not roll out: %w: %s\n%s",
			kind, name, err, strings.TrimSpace(out.String()), describe(ctx, ns, name))
	}
	return nil
}

// WaitJob blocks until a Job completes, and fails on the Job's own terms.
//
// `kubectl wait` has to be told which end it is waiting for, and waiting only
// for "complete" hangs for the whole timeout on a Job that already failed. Both
// conditions are watched, and the first to fire decides — cancelling the other,
// so a success returns at once instead of waiting out the timeout that the
// losing watcher is still holding.
func WaitJob(ctx context.Context, name string, timeout time.Duration) error {
	ns, err := Namespace()
	if err != nil {
		return err
	}
	watch, stop := context.WithCancel(ctx)
	defer stop()

	type outcome struct {
		failed bool
		fired  bool
	}
	results := make(chan outcome, 2)
	for _, cond := range []string{"complete", "failed"} {
		go func(cond string) {
			cmd := exec.CommandContext(watch, "kubectl", "-n", ns, "wait",
				"--for=condition="+cond, "job/"+name, "--timeout="+timeout.String())
			cmd.Stdout, cmd.Stderr = nil, nil
			err := cmd.Run()
			results <- outcome{failed: cond == "failed", fired: err == nil}
		}(cond)
	}

	for i := 0; i < 2; i++ {
		r := <-results
		if !r.fired {
			continue
		}
		stop()
		if r.failed {
			return fmt.Errorf("job %s failed: %s", name, jobLog(ctx, ns, name))
		}
		return nil
	}
	return fmt.Errorf("job %s neither completed nor failed within %s", name, timeout)
}

// jobLog is what the Job said, which is the only useful part of "it failed".
func jobLog(ctx context.Context, ns, name string) string {
	out, err := exec.CommandContext(ctx, "kubectl", "-n", ns, "logs",
		"job/"+name, "--tail=20").Output()
	if err != nil {
		return "(no log)"
	}
	return strings.TrimSpace(string(out))
}

// PodInfo is what a caller outside this package needs to know about a pod
// without learning the API's shape.
type PodInfo struct {
	Name        string
	Labels      map[string]string
	Annotations map[string]string
	Created     int64
	Running     bool
}

// ListPods reports the bitswan-managed pods in this namespace.
//
// Scoped to what this Bailey manages, deliberately: a namespace can hold things
// that are none of its business, and counting them would make its memory budget
// somebody else's.
func ListPods(ctx context.Context) ([]PodInfo, error) {
	ns, err := Namespace()
	if err != nil {
		return nil, err
	}
	out, err := exec.CommandContext(ctx, "kubectl", "-n", ns, "get", "pods",
		"-l", k8srender.ManagedByLabel+"="+k8srender.ManagedBy, "-o", "json").Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl get pods: %w", err)
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Labels            map[string]string `json:"labels"`
				Annotations       map[string]string `json:"annotations"`
				CreationTimestamp time.Time         `json:"creationTimestamp"`
			} `json:"metadata"`
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, fmt.Errorf("parse pod list: %w", err)
	}
	pods := make([]PodInfo, 0, len(list.Items))
	for _, it := range list.Items {
		pods = append(pods, PodInfo{
			Name:        it.Metadata.Name,
			Labels:      it.Metadata.Labels,
			Annotations: it.Metadata.Annotations,
			Created:     it.Metadata.CreationTimestamp.Unix(),
			Running:     it.Status.Phase == "Running",
		})
	}
	return pods, nil
}

// PodMemoryUsage is live memory per pod, or nothing when the metrics API is
// absent. Nothing rather than zeroes: a zero reads as "this uses no memory",
// which would make the budget confidently wrong.
func PodMemoryUsage(ctx context.Context) (map[string]int64, error) {
	ns, err := Namespace()
	if err != nil {
		return nil, err
	}
	out, err := exec.CommandContext(ctx, "kubectl", "-n", ns, "top", "pods", "--no-headers").Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl top pods: %w", err)
	}
	usage := map[string]int64{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		if b := MemoryQuantityBytes(f[2]); b > 0 {
			usage[f[0]] = b
		}
	}
	return usage, nil
}

// Get returns an object, or every object of a kind when name is empty.
func Get(ctx context.Context, kind, name string) ([]byte, error) {
	ns, err := Namespace()
	if err != nil {
		return nil, err
	}
	args := []string{"-n", ns, "get", kind}
	if name != "" {
		args = append(args, name)
	}
	args = append(args, "-o", "json")
	out, err := exec.CommandContext(ctx, "kubectl", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl get %s: %w", kind, err)
	}
	return out, nil
}

// MemoryQuantityBytes reads a Kubernetes memory quantity, and reports zero for
// anything it does not recognise so a caller can tell "no answer" from a number
// this invented.
func MemoryQuantityBytes(v string) int64 {
	v = strings.TrimSpace(v)
	for _, u := range []struct {
		suffix string
		mult   int64
	}{
		{"Ki", 1 << 10}, {"Mi", 1 << 20}, {"Gi", 1 << 30}, {"Ti", 1 << 40},
		{"k", 1000}, {"M", 1000 * 1000}, {"G", 1000 * 1000 * 1000},
	} {
		if strings.HasSuffix(v, u.suffix) {
			n, err := strconv.ParseFloat(strings.TrimSuffix(v, u.suffix), 64)
			if err != nil {
				return 0
			}
			return int64(n * float64(u.mult))
		}
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
