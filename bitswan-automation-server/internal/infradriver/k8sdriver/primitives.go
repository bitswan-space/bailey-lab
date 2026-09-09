package k8sdriver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// The operational half of the contract: what gitops asks about a workspace's
// containers, answered about its pods.
//
// Every call resolves through target(), which re-checks that the pod is in this
// driver's namespace and carries this driver's workspace label before anything
// acts on it — the same refusal the Docker driver makes, with the difference
// that here the namespace half is also enforced by the API server.

type podRef struct {
	pod       string
	container string
	labels    map[string]string
	state     string
	health    string
	image     string
	created   int64
	id        string
}

func (d *K8sDriver) kubectl(ctx context.Context, args ...string) ([]byte, error) {
	full := append([]string{"-n", d.namespace}, args...)
	cmd := exec.CommandContext(ctx, "kubectl", full...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("kubectl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}

// selectorFor builds a label selector from a caller's filter, projecting each
// value exactly as it was projected when the label was stamped, and returning
// whatever could not be expressed as a label so it can be matched in Go.
//
// The workspace is always forced and any caller-supplied workspace is dropped: a
// listing must never be able to name someone else's.
func (d *K8sDriver) selectorFor(filter infradriver.ContainerFilter) (string, map[string]string) {
	selectors := []string{k8srender.WorkspaceLabel + "=" + k8srender.LabelValue(d.workspace)}
	post := map[string]string{}
	for k, v := range filter.Labels {
		if k == "gitops.workspace" {
			continue
		}
		switch k {
		case "gitops.deployment_id":
			// The raw value is an annotation, because it carries an "@" once a
			// slot is involved. Match it in Go against the annotation instead of
			// pretending a label can hold it.
			post[k] = v
		default:
			selectors = append(selectors, k+"="+k8srender.LabelValue(v))
		}
	}
	return strings.Join(selectors, ","), post
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name              string            `json:"name"`
			UID               string            `json:"uid"`
			Labels            map[string]string `json:"labels"`
			Annotations       map[string]string `json:"annotations"`
			CreationTimestamp time.Time         `json:"creationTimestamp"`
		} `json:"metadata"`
		Status struct {
			Phase             string `json:"phase"`
			PodIP             string `json:"podIP"`
			ContainerStatuses []struct {
				Name         string `json:"name"`
				Ready        bool   `json:"ready"`
				RestartCount int    `json:"restartCount"`
				Image        string `json:"image"`
				State        map[string]struct {
					StartedAt time.Time `json:"startedAt"`
					Reason    string    `json:"reason"`
					ExitCode  int       `json:"exitCode"`
				} `json:"state"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

func (d *K8sDriver) pods(ctx context.Context, filter infradriver.ContainerFilter) ([]podRef, error) {
	selector, post := d.selectorFor(filter)
	raw, err := d.kubectl(ctx, "get", "pods", "-l", selector, "-o", "json")
	if err != nil {
		return nil, err
	}
	var list podList
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("parse pod list: %w", err)
	}
	var out []podRef
	for _, item := range list.Items {
		labels := mergedLabels(item.Metadata.Labels, item.Metadata.Annotations)
		if !matchesAll(labels, post) {
			continue
		}
		name := labels["bitswan.io/name"]
		if name == "" {
			name = item.Metadata.Name
		}
		for _, cs := range item.Status.ContainerStatuses {
			state, health := stateAndHealth(cs.Ready, cs.State)
			out = append(out, podRef{
				pod:       item.Metadata.Name,
				container: cs.Name,
				labels:    labels,
				state:     state,
				health:    health,
				image:     cs.Image,
				created:   item.Metadata.CreationTimestamp.Unix(),
				id:        item.Metadata.Name + "/" + cs.Name,
			})
		}
	}
	return out, nil
}

// mergedLabels reports the labels a caller sees: the projected ones, overlaid by
// the raw values kept as annotations, so gitops reads back exactly what it wrote
// even where a label could not hold it.
func mergedLabels(labels, annotations map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range labels {
		out[k] = v
	}
	for k, v := range annotations {
		if strings.HasPrefix(k, "gitops.bitswan.io/") {
			out["gitops."+strings.TrimPrefix(k, "gitops.bitswan.io/")] = v
		}
		if k == "bitswan.io/name" {
			out[k] = v
		}
	}
	return out
}

func matchesAll(have, want map[string]string) bool {
	for k, v := range want {
		if have[k] != v {
			return false
		}
	}
	return true
}

func stateAndHealth(ready bool, state map[string]struct {
	StartedAt time.Time `json:"startedAt"`
	Reason    string    `json:"reason"`
	ExitCode  int       `json:"exitCode"`
}) (string, string) {
	switch {
	case state["running"].StartedAt.IsZero() == false:
		if ready {
			return "running", "healthy"
		}
		return "running", "starting"
	case state["terminated"].Reason != "":
		return "exited", "unhealthy"
	default:
		return "created", ""
	}
}

func (d *K8sDriver) target(ctx context.Context, container string) (podRef, error) {
	if container == "" {
		return podRef{}, fmt.Errorf("no container named")
	}
	all, err := d.pods(ctx, infradriver.ContainerFilter{})
	if err != nil {
		return podRef{}, err
	}
	// The handle this driver hands out, a Docker-style name, or a bare pod: in
	// that order, and never a guess.
	for _, p := range all {
		if p.id == container {
			return p, nil
		}
	}
	for _, p := range all {
		if p.labels["bitswan.io/name"] == container {
			return p, nil
		}
	}
	for _, p := range all {
		if p.pod == container {
			return p, nil
		}
	}
	return podRef{}, fmt.Errorf("refused: %q is not a container of workspace %q in namespace %q",
		container, d.workspace, d.namespace)
}

func (d *K8sDriver) ContainerList(ctx context.Context, req infradriver.WorkspaceContext, filter infradriver.ContainerFilter) ([]infradriver.Container, error) {
	pods, err := d.pods(ctx, filter)
	if err != nil {
		return nil, err
	}
	out := make([]infradriver.Container, 0, len(pods))
	for _, p := range pods {
		out = append(out, infradriver.Container{
			ID:      p.id,
			Name:    p.labels["bitswan.io/name"],
			State:   p.state,
			Health:  p.health,
			Image:   p.image,
			Created: p.created,
			Labels:  p.labels,
		})
	}
	return out, nil
}

// ContainerStats reports live memory, and reports NOTHING when the metrics API
// is absent rather than reporting zeroes: an empty listing reads as "nothing to
// show", where a zero reads as "this workload uses no memory" and would make the
// memory page and its over-reservation events confidently wrong.
func (d *K8sDriver) ContainerStats(ctx context.Context, req infradriver.WorkspaceContext, filter infradriver.ContainerFilter) ([]infradriver.ContainerStat, error) {
	pods, err := d.pods(ctx, filter)
	if err != nil {
		return nil, err
	}
	raw, err := d.kubectl(ctx, "top", "pods", "--no-headers", "--containers")
	if err != nil {
		return nil, nil
	}
	usage := map[string]int64{}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 {
			continue
		}
		usage[fields[0]+"/"+fields[1]] = parseMi(fields[3])
	}
	var out []infradriver.ContainerStat
	for _, p := range pods {
		out = append(out, infradriver.ContainerStat{
			ID:            p.id,
			Name:          p.labels["bitswan.io/name"],
			MemUsageBytes: usage[p.id],
			Labels:        p.labels,
		})
	}
	return out, nil
}

func parseMi(s string) int64 {
	s = strings.TrimSpace(s)
	mult := int64(1)
	switch {
	case strings.HasSuffix(s, "Mi"):
		s, mult = strings.TrimSuffix(s, "Mi"), 1024*1024
	case strings.HasSuffix(s, "Gi"):
		s, mult = strings.TrimSuffix(s, "Gi"), 1024*1024*1024
	case strings.HasSuffix(s, "Ki"):
		s, mult = strings.TrimSuffix(s, "Ki"), 1024
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n * mult
}

func (d *K8sDriver) ContainerLogs(ctx context.Context, req infradriver.WorkspaceContext, container string, tail int, follow bool, sink func(infradriver.LogLine)) error {
	t, err := d.target(ctx, container)
	if err != nil {
		return err
	}
	args := []string{"-n", d.namespace, "logs", t.pod, "-c", t.container}
	if tail > 0 {
		args = append(args, "--tail", strconv.Itoa(tail))
	}
	if follow {
		args = append(args, "-f")
	}
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		// Kubernetes does not separate the two streams in a log, so every line
		// arrives as stdout. Nothing downstream distinguishes them today, but it
		// is a fidelity gap rather than a choice.
		sink(infradriver.LogLine{Line: sc.Text()})
	}
	_ = cmd.Wait()
	return nil
}

// ContainerEvents reports when a workspace's containers come up, go away or
// change readiness.
//
// gitops uses this only as a signal that something changed — it re-reads live
// state itself — so a watch of the workspace's pods carries exactly the
// information it needs, including a health transition, which Kubernetes has no
// concept of beyond readiness.
func (d *K8sDriver) ContainerEvents(ctx context.Context, req infradriver.WorkspaceContext, sink func(infradriver.ContainerEvent)) error {
	seen := map[string]string{}
	first := true
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		pods, err := d.pods(ctx, infradriver.ContainerFilter{})
		if err == nil {
			now := map[string]string{}
			for _, p := range pods {
				now[p.id] = p.state + "/" + p.health
			}
			if !first {
				for id, state := range now {
					if prev, ok := seen[id]; !ok || prev != state {
						sink(infradriver.ContainerEvent{
							Action:    actionFor(state),
							Container: id,
							ID:        id,
						})
					}
				}
				for id := range seen {
					if _, ok := now[id]; !ok {
						sink(infradriver.ContainerEvent{Action: "destroy", Container: id, ID: id})
					}
				}
			}
			seen, first = now, false
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(3 * time.Second):
		}
	}
}

func actionFor(state string) string {
	switch {
	case strings.HasPrefix(state, "running/healthy"):
		return "health_status"
	case strings.HasPrefix(state, "running"):
		return "start"
	case strings.HasPrefix(state, "exited"):
		return "die"
	default:
		return "start"
	}
}

// ContainerStop scales the workload to nothing.
//
// Deleting the pod would be a restart, because something would immediately
// recreate it. Docker's stop leaves a container stopped, so the faithful mapping
// is to stop wanting it.
func (d *K8sDriver) ContainerStop(ctx context.Context, req infradriver.WorkspaceContext, container string) error {
	owner, err := d.ownerOf(ctx, container)
	if err != nil {
		return err
	}
	_, err = d.kubectl(ctx, "scale", owner, "--replicas=0")
	return err
}

// ContainerRestart replaces the pod, which is what a restart is here.
func (d *K8sDriver) ContainerRestart(ctx context.Context, req infradriver.WorkspaceContext, container string) error {
	t, err := d.target(ctx, container)
	if err != nil {
		return err
	}
	_, err = d.kubectl(ctx, "delete", "pod", t.pod, "--wait=false")
	return err
}

// ContainerRemove deletes the workload.
//
// The contract is "make an inactive deployment cost nothing", and the caller has
// already recorded that it is inactive, so nothing recreates it. Deleting only
// the pod would achieve nothing at all.
func (d *K8sDriver) ContainerRemove(ctx context.Context, req infradriver.WorkspaceContext, container string) error {
	owner, err := d.ownerOf(ctx, container)
	if err != nil {
		return err
	}
	if strings.HasPrefix(owner, "statefulset/") {
		return fmt.Errorf("refused: %s holds data; scale or delete it deliberately", owner)
	}
	_, err = d.kubectl(ctx, "delete", owner, "--ignore-not-found=true", "--wait=false")
	return err
}

func (d *K8sDriver) ownerOf(ctx context.Context, container string) (string, error) {
	t, err := d.target(ctx, container)
	if err != nil {
		return "", err
	}
	raw, err := d.kubectl(ctx, "get", "pod", t.pod, "-o",
		"jsonpath={.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}")
	if err != nil {
		return "", err
	}
	kind, name, ok := strings.Cut(strings.TrimSpace(string(raw)), "/")
	if !ok || name == "" {
		return "pod/" + t.pod, nil
	}
	switch strings.ToLower(kind) {
	case "replicaset":
		// A ReplicaSet is an implementation detail of the Deployment that owns
		// it, and acting on it would be undone the moment the Deployment noticed.
		rsOwner, err := d.kubectl(ctx, "get", "replicaset", name, "-o",
			"jsonpath={.metadata.ownerReferences[0].name}")
		if err != nil {
			return "", err
		}
		return "deployment/" + strings.TrimSpace(string(rsOwner)), nil
	case "statefulset":
		return "statefulset/" + name, nil
	default:
		return strings.ToLower(kind) + "/" + name, nil
	}
}

// ContainerInspect answers in the shape its readers parse, which is a Docker
// inspect record. Only the fields they actually read are filled in, and the
// environment is resolved rather than left as the references the pod carries.
func (d *K8sDriver) ContainerInspect(ctx context.Context, req infradriver.WorkspaceContext, container string) ([]byte, error) {
	t, err := d.target(ctx, container)
	if err != nil {
		return nil, err
	}
	raw, err := d.kubectl(ctx, "get", "pod", t.pod, "-o", "json")
	if err != nil {
		return nil, err
	}
	var pod struct {
		Metadata struct {
			Name              string            `json:"name"`
			Labels            map[string]string `json:"labels"`
			Annotations       map[string]string `json:"annotations"`
			CreationTimestamp time.Time         `json:"creationTimestamp"`
		} `json:"metadata"`
		Spec struct {
			Containers []struct {
				Name  string `json:"name"`
				Image string `json:"image"`
				Env   []struct {
					Name  string `json:"name"`
					Value string `json:"value"`
				} `json:"env"`
			} `json:"containers"`
		} `json:"spec"`
		Status struct {
			PodIP             string `json:"podIP"`
			ContainerStatuses []struct {
				Name         string `json:"name"`
				Ready        bool   `json:"ready"`
				RestartCount int    `json:"restartCount"`
				Image        string `json:"image"`
			} `json:"containerStatuses"`
		} `json:"status"`
	}
	if err := json.Unmarshal(raw, &pod); err != nil {
		return nil, err
	}

	env := []string{}
	for _, c := range pod.Spec.Containers {
		if c.Name != t.container {
			continue
		}
		for _, e := range c.Env {
			env = append(env, e.Name+"="+e.Value)
		}
	}
	restarts := 0
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name == t.container {
			restarts = cs.RestartCount
		}
	}

	record := map[string]interface{}{
		"Id":           t.id,
		"Name":         "/" + t.labels["bitswan.io/name"],
		"Created":      pod.Metadata.CreationTimestamp.Format(time.RFC3339),
		"RestartCount": restarts,
		"State": map[string]interface{}{
			"Status": t.state,
			"Health": map[string]interface{}{"Status": t.health},
		},
		"Config": map[string]interface{}{
			"Image":    t.image,
			"Hostname": t.pod,
			"Labels":   t.labels,
			"Env":      env,
		},
		"HostConfig": map[string]interface{}{},
		"NetworkSettings": map[string]interface{}{
			"Networks": map[string]interface{}{
				d.workspace: map[string]interface{}{"IPAddress": pod.Status.PodIP},
			},
		},
	}
	return json.Marshal([]interface{}{record})
}

func (d *K8sDriver) ContainerExec(ctx context.Context, req infradriver.WorkspaceContext, spec infradriver.ExecSpec, in io.Reader, out func(stderr bool, chunk []byte)) (int, error) {
	t, err := d.target(ctx, spec.Container)
	if err != nil {
		return -1, err
	}
	if spec.User != "" {
		// Exec always runs as the container's own user here. Saying so is better
		// than running as the wrong one and letting the caller believe otherwise.
		return -1, fmt.Errorf("refused: exec as a chosen user is not supported on kubernetes (asked for %q)", spec.User)
	}
	args := []string{"-n", d.namespace, "exec", t.pod, "-c", t.container}
	if in != nil {
		args = append(args, "-i")
	}
	if spec.Tty {
		args = append(args, "-t")
	}
	args = append(args, "--")
	args = append(args, spec.Cmd...)

	cmd := exec.CommandContext(ctx, "kubectl", args...)
	if in != nil {
		cmd.Stdin = in
	}
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	done := make(chan struct{}, 2)
	pump := func(r io.Reader, isErr bool) {
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				out(isErr, chunk)
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}
	go pump(stdout, false)
	go pump(stderr, true)
	<-done
	<-done
	err = cmd.Wait()
	if err == nil {
		return 0, nil
	}
	if ee, ok := err.(*exec.ExitError); ok {
		// A command that ran and failed is a result, not an error: the caller
		// wants the code.
		return ee.ExitCode(), nil
	}
	return -1, err
}
