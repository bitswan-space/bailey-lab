package daemon

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	collogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

// testLogsServer is a minimal in-process OTLP/gRPC LogsService that captures
// what was exported, standing in for a real OpenTelemetry collector.
type testLogsServer struct {
	collogspb.UnimplementedLogsServiceServer
	got  chan *collogspb.ExportLogsServiceRequest
	auth chan string
}

func (s *testLogsServer) Export(ctx context.Context, req *collogspb.ExportLogsServiceRequest) (*collogspb.ExportLogsServiceResponse, error) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if a := md.Get("authorization"); len(a) > 0 {
			select {
			case s.auth <- a[0]:
			default:
			}
		}
	}
	s.got <- req
	return &collogspb.ExportLogsServiceResponse{}, nil
}

func startGRPCLogsReceiver(t *testing.T) (addr string, ts *testLogsServer) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	ts = &testLogsServer{got: make(chan *collogspb.ExportLogsServiceRequest, 8), auth: make(chan string, 8)}
	collogspb.RegisterLogsServiceServer(srv, ts)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String(), ts
}

// The headline gRPC test: an audit event recorded via recordEvent is exported
// over OTLP/gRPC to a running LogsService, with the same actor/action/target.
func TestSIEMForwardsAuditEvents_GRPC(t *testing.T) {
	resetSIEM(t)
	addr, ts := startGRPCLogsReceiver(t)

	if err := setSIEMConfig(siemConfig{
		Enabled:   true,
		Protocol:  siemProtocolGRPC,
		Endpoint:  "http://" + addr, // http:// → plaintext (no TLS) for the test
		AuthToken: "grpc-token",
	}, "test"); err != nil {
		t.Fatal(err)
	}

	if err := recordEvent("carol@example.com", auditWorkspaceCreate, "ws-payroll"); err != nil {
		t.Fatal(err)
	}

	select {
	case req := <-ts.got:
		if len(req.ResourceLogs) == 0 || len(req.ResourceLogs[0].ScopeLogs) == 0 || len(req.ResourceLogs[0].ScopeLogs[0].LogRecords) == 0 {
			t.Fatal("export had no log records")
		}
		rec := req.ResourceLogs[0].ScopeLogs[0].LogRecords[0]
		body := rec.Body.GetStringValue()
		if !strings.Contains(body, auditWorkspaceCreate) || !strings.Contains(body, "carol@example.com") {
			t.Errorf("log body %q missing action/actor", body)
		}
		attrs := map[string]string{}
		for _, a := range rec.Attributes {
			attrs[a.Key] = a.Value.GetStringValue()
		}
		if attrs["event.name"] != auditWorkspaceCreate {
			t.Errorf("event.name = %q; want %q", attrs["event.name"], auditWorkspaceCreate)
		}
		if attrs["enduser.id"] != "carol@example.com" {
			t.Errorf("enduser.id = %q; want carol@example.com", attrs["enduser.id"])
		}
		if attrs["event.target"] != "ws-payroll" {
			t.Errorf("event.target = %q; want ws-payroll", attrs["event.target"])
		}
	case <-time.After(4 * time.Second):
		t.Fatal("no OTLP/gRPC export received within timeout")
	}

	select {
	case a := <-ts.auth:
		if a != "Bearer grpc-token" {
			t.Errorf("authorization metadata = %q; want Bearer grpc-token", a)
		}
	case <-time.After(time.Second):
		t.Error("no authorization metadata received")
	}
}

func TestOTLPGRPCTarget(t *testing.T) {
	cases := []struct {
		name         string
		cfg          siemConfig
		wantTarget   string
		wantInsecure bool
	}{
		{"http → insecure, default port", siemConfig{Endpoint: "http://c.example.com"}, "c.example.com:4317", true},
		{"https → TLS, explicit port", siemConfig{Endpoint: "https://c.example.com:9999"}, "c.example.com:9999", false},
		{"bare host → TLS, default port", siemConfig{Endpoint: "c.example.com"}, "c.example.com:4317", false},
		{"port override wins", siemConfig{Endpoint: "http://c.example.com:1111", Port: 4317}, "c.example.com:4317", true},
		{"path stripped", siemConfig{Endpoint: "http://c.example.com:4317/v1/logs"}, "c.example.com:4317", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			target, insec, err := otlpGRPCTarget(c.cfg)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if target != c.wantTarget || insec != c.wantInsecure {
				t.Errorf("otlpGRPCTarget = (%q, %v); want (%q, %v)", target, insec, c.wantTarget, c.wantInsecure)
			}
		})
	}
	if _, _, err := otlpGRPCTarget(siemConfig{Endpoint: ""}); err == nil {
		t.Error("empty endpoint should error")
	}
}
