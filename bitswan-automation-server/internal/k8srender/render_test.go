package k8srender

import (
	"strings"
	"testing"
)

func TestNameLeavesALegalNameAlone(t *testing.T) {
	if got := Name("finance-gitops", ServiceNameMax); got != "finance-gitops" {
		t.Fatalf("Name() = %q, want it unchanged", got)
	}
}

func TestNameShortensDeterministicallyAndKeepsNamesApart(t *testing.T) {
	long := strings.Repeat("a", 60) + "-backend"
	other := strings.Repeat("a", 60) + "-frontend"

	got, again := Name(long, WorkloadNameMax), Name(long, WorkloadNameMax)
	if got != again {
		t.Fatalf("Name() is not deterministic: %q then %q", got, again)
	}
	if len(got) > WorkloadNameMax {
		t.Fatalf("Name() = %q (%d chars), over the %d budget", got, len(got), WorkloadNameMax)
	}
	if Name(other, WorkloadNameMax) == got {
		t.Fatalf("two distinct names both shortened to %q", got)
	}
}

func TestNameIsALegalDNSLabel(t *testing.T) {
	for _, in := range []string{"Finance__Gitops", "-leading", "trailing-", "a..b", "UPPER"} {
		got := Name(in, ServiceNameMax)
		if strings.ContainsAny(got, "_.") || strings.ToLower(got) != got {
			t.Fatalf("Name(%q) = %q, which is not a DNS label", in, got)
		}
		if strings.HasPrefix(got, "-") || strings.HasSuffix(got, "-") {
			t.Fatalf("Name(%q) = %q, which starts or ends with a dash", in, got)
		}
	}
}

func TestLabelValueRoundTripsAnIdentifierWithASlot(t *testing.T) {
	raw := "backend-test@green"
	stamped := LabelValue(raw)
	if strings.Contains(stamped, "@") {
		t.Fatalf("LabelValue(%q) = %q, still carries an illegal character", raw, stamped)
	}
	if selected := LabelValue(raw); selected != stamped {
		t.Fatalf("stamped %q but a selector built from the same value gives %q", stamped, selected)
	}
}

func TestLabelValueBoundsAContentHash(t *testing.T) {
	raw := strings.Repeat("a", 64)
	got := LabelValue(raw)
	if len(got) > LabelValueMax {
		t.Fatalf("LabelValue() = %d chars, over the %d limit", len(got), LabelValueMax)
	}
}

func TestAWorkspaceWorkloadGetsNoAPICredential(t *testing.T) {
	objs := Deployment(Workload{Name: "finance-gitops", Workspace: "finance", Image: "img:1"})
	spec := podSpecOf(t, objs[0])
	if spec["serviceAccountName"] != nil {
		t.Fatal("a workspace workload named a service account")
	}
	if spec["automountServiceAccountToken"] != false {
		t.Fatal("a workspace workload would be handed an API token it never asked for")
	}
}

func TestAListeningWorkloadGetsAServiceNamedForIt(t *testing.T) {
	objs := Deployment(Workload{
		Name:      "finance-gitops",
		Workspace: "finance",
		Image:     "img:1",
		Ports:     []Port{{Name: "http", Port: 8079}},
	})
	if len(objs) != 2 {
		t.Fatalf("got %d objects, want a Deployment and a Service", len(objs))
	}
	if got := objs[1]["kind"]; got != "Service" {
		t.Fatalf("second object is %v, want a Service", got)
	}
	meta := objs[1]["metadata"].(map[string]interface{})
	if meta["name"] != "finance-gitops" {
		t.Fatalf("Service is named %v, want finance-gitops", meta["name"])
	}
}

func TestASilentWorkloadGetsNoService(t *testing.T) {
	objs := Deployment(Workload{Name: "finance-agent", Workspace: "finance", Image: "img:1"})
	if len(objs) != 1 {
		t.Fatalf("got %d objects, want only a Deployment", len(objs))
	}
}

func TestAnEmptyStorageClassIsOmittedRatherThanSetEmpty(t *testing.T) {
	spec := PVC("workspace-finance", "20Gi", "")["spec"].(map[string]interface{})
	if _, ok := spec["storageClassName"]; ok {
		t.Fatal("storageClassName was set to empty rather than left out")
	}
	spec = PVC("workspace-finance", "20Gi", "local-path")["spec"].(map[string]interface{})
	if spec["storageClassName"] != "local-path" {
		t.Fatalf("storageClassName = %v, want local-path", spec["storageClassName"])
	}
}

func TestMarshalIsStable(t *testing.T) {
	w := Workload{
		Name:      "finance-gitops",
		Workspace: "finance",
		Image:     "img:1",
		Env:       map[string]string{"B": "2", "A": "1", "C": "3"},
	}
	first, err := Deployment(w).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	second, err := Deployment(w).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("the same declaration rendered differently twice")
	}
	if !strings.Contains(string(first), "name: A") {
		t.Fatal("environment did not render")
	}
	if strings.Index(string(first), "name: A") > strings.Index(string(first), "name: B") {
		t.Fatal("environment is not in a stable order")
	}
}

func podSpecOf(t *testing.T, dep Object) map[string]interface{} {
	t.Helper()
	spec := dep["spec"].(map[string]interface{})
	tmpl := spec["template"].(map[string]interface{})
	return tmpl["spec"].(map[string]interface{})
}
