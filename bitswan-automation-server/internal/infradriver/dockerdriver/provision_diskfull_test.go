package dockerdriver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

func fakePostgresOutOfDiskWhileFull(t *testing.T, dbs map[string]bool, diskFull *bool) (restore func()) {
	t.Helper()
	orig := dockerExec
	dockerExec = func(_ context.Context, _ string, args ...string) (string, string, int) {
		sql := ""
		if len(args) > 0 {
			sql = args[len(args)-1]
		}
		switch {
		case strings.HasPrefix(sql, "SELECT 1 FROM pg_database WHERE datname = '"):
			name := strings.TrimSuffix(strings.TrimPrefix(sql, "SELECT 1 FROM pg_database WHERE datname = '"), "';")
			if dbs[name] {
				return "1\n", "", 0
			}
			return "\n", "", 0
		case sql == "SELECT datname FROM pg_database":
			names := make([]string, 0, len(dbs))
			for name := range dbs {
				names = append(names, name)
			}
			return strings.Join(names, "\n") + "\n", "", 0
		case strings.HasPrefix(sql, "CREATE DATABASE "):
			if *diskFull {
				return "", `ERROR:  could not create directory "base/16471": No space left on device`, 1
			}
			rest := strings.TrimPrefix(sql, "CREATE DATABASE ")
			if quoted := strings.Split(rest, `"`); len(quoted) > 1 {
				dbs[quoted[1]] = true
			}
			return "", "", 0
		}
		return "", "", 0
	}
	return func() { dockerExec = orig }
}

func stubDockerReportingEveryContainerHealthy(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\ncase \"$1\" in inspect) echo healthy;; esac\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestRedeployCreatesTheLiveDatabaseAFullDiskPreventedTheFirstDeployFromCreating(t *testing.T) {
	cases := []struct {
		name   string
		dep    *Deployment
		wantDB string
	}{
		{
			name:   "main copy, dev stage",
			dep:    &Deployment{Stage: "dev", RelativePath: "gradesta/backend"},
			wantDB: "bp_gradesta",
		},
		{
			name:   "a copy's live-dev",
			dep:    &Deployment{Stage: "live-dev", RelativePath: "copies/alice/gradesta/backend"},
			wantDB: "copy_alice_bp_gradesta",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stubDockerReportingEveryContainerHealthy(t)

			secrets := t.TempDir()
			mustWrite(t, filepath.Join(secrets, "postgres-dev"), "POSTGRES_USER=admin\nPOSTGRES_DB=postgres\n")
			mustWrite(t, filepath.Join(secrets, "bp-databases.json"),
				`{"version":1,"bps":{"gradesta":{"bp_name":"gradesta","stages":{"dev":{}}}}}`)

			dbs := map[string]bool{"postgres": true}
			diskFull := true
			defer fakePostgresOutOfDiskWhileFull(t, dbs, &diskFull)()

			wctx := infradriver.WorkspaceContext{WorkspaceName: "ws", SecretsDir: secrets, GitopsDir: t.TempDir()}
			bs := &Bitswan{Deployments: map[string]*Deployment{"gradesta-backend": c.dep}}
			quiet := func(string, string) {}

			postgres := containerInfo{id: "pg-1", state: "running"}
			backendBroughtUpByThisApply := containerInfo{id: "backend-1", state: "running",
				labels: map[string]string{"gitops.deployment_id": "gradesta-backend"}}

			err := ensureLivePostgresDBs(context.Background(), wctx, bs,
				map[string]bool{postgres.id: true},
				[]containerInfo{postgres, backendBroughtUpByThisApply}, quiet)
			if err == nil || !strings.Contains(err.Error(), "No space left on device") {
				t.Fatalf("first deploy on a full disk: err = %v, want a CREATE DATABASE out-of-disk failure", err)
			}
			if dbs[c.wantDB] {
				t.Fatalf("%s was created despite the full disk — the fake postgres is wrong", c.wantDB)
			}

			diskFull = false
			backendKeptByCompose := backendBroughtUpByThisApply
			backendKeptByCompose.state = "restarting"

			if err := ensureLivePostgresDBs(context.Background(), wctx, bs,
				map[string]bool{postgres.id: true, backendKeptByCompose.id: true},
				[]containerInfo{postgres, backendKeptByCompose}, quiet); err != nil {
				t.Fatalf("redeploy after freeing disk space: unexpected error %v", err)
			}
			if !dbs[c.wantDB] {
				t.Errorf("redeploy after freeing disk space did not create %s — the BP stays broken (issue #413)", c.wantDB)
			}
		})
	}
}

func TestSteadyStateReconcileListsDatabasesOncePerRealmAndReprovisionsNothing(t *testing.T) {
	stubDockerReportingEveryContainerHealthy(t)

	secrets := t.TempDir()
	mustWrite(t, filepath.Join(secrets, "postgres-dev"), "POSTGRES_USER=admin\nPOSTGRES_DB=postgres\n")
	mustWrite(t, filepath.Join(secrets, "bp-databases.json"),
		`{"version":1,"bps":{"gradesta":{"bp_name":"gradesta","stages":{"dev":{}}},"ledger":{"bp_name":"ledger","stages":{"dev":{}}}}}`)

	var stmts []string
	orig := dockerExec
	dockerExec = func(_ context.Context, _ string, args ...string) (string, string, int) {
		sql := ""
		if len(args) > 0 {
			sql = args[len(args)-1]
		}
		stmts = append(stmts, sql)
		if sql == "SELECT datname FROM pg_database" {
			return "postgres\nbp_gradesta\nbp_ledger\n", "", 0
		}
		return "", "", 0
	}
	defer func() { dockerExec = orig }()

	wctx := infradriver.WorkspaceContext{WorkspaceName: "ws", SecretsDir: secrets, GitopsDir: t.TempDir()}
	bs := &Bitswan{Deployments: map[string]*Deployment{
		"gradesta-backend": {Stage: "dev", RelativePath: "gradesta/backend"},
		"ledger-backend":   {Stage: "dev", RelativePath: "ledger/backend"},
	}}

	preExisting := map[string]bool{"pg-1": true, "b1": true, "b2": true}
	infos := []containerInfo{
		{id: "pg-1", state: "running"},
		{id: "b1", state: "running", labels: map[string]string{"gitops.deployment_id": "gradesta-backend"}},
		{id: "b2", state: "running", labels: map[string]string{"gitops.deployment_id": "ledger-backend"}},
	}
	if err := ensureLivePostgresDBs(context.Background(), wctx, bs, preExisting, infos, func(string, string) {}); err != nil {
		t.Fatalf("steady-state reconcile: %v", err)
	}

	if len(stmts) != 1 || stmts[0] != "SELECT datname FROM pg_database" {
		t.Errorf("steady-state reconcile issued %d statement(s), want one memoized database list:\n%s",
			len(stmts), strings.Join(stmts, "\n"))
	}
}
