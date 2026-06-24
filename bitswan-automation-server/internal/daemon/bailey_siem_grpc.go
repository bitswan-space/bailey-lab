package daemon

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strconv"
	"strings"

	collogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// OTLP/gRPC transport for SIEM forwarding — the gRPC sibling of the OTLP/HTTP
// path in bailey_siem.go. We build the OTLP proto request directly and call
// LogsService/Export, rather than pulling the full OpenTelemetry SDK, keeping
// the dependency surface to the proto types + grpc that this needs.

// otlpDefaultGRPCPort is the conventional OTLP/gRPC receiver port.
const otlpDefaultGRPCPort = "4317"

// otlpGRPCTarget resolves the dial target (host:port) and whether to use an
// insecure (plaintext) connection. Scheme handling mirrors collector
// conventions: an explicit http:// means plaintext; https:// or a bare
// host[:port] means TLS. An explicit Port override wins over the URL's port,
// and the default OTLP/gRPC port is used when none is given.
func otlpGRPCTarget(c siemConfig) (target string, useInsecure bool, err error) {
	raw := strings.TrimSpace(c.Endpoint)
	if raw == "" {
		return "", false, fmt.Errorf("endpoint is required")
	}
	switch {
	case strings.HasPrefix(raw, "http://"):
		useInsecure = true
		raw = strings.TrimPrefix(raw, "http://")
	case strings.HasPrefix(raw, "https://"):
		raw = strings.TrimPrefix(raw, "https://")
	case strings.Contains(raw, "://"):
		return "", false, fmt.Errorf("unsupported scheme in endpoint %q", c.Endpoint)
	}
	// Strip any path/query — gRPC dials host:port only.
	if i := strings.IndexAny(raw, "/?"); i >= 0 {
		raw = raw[:i]
	}
	host := raw
	port := ""
	if h, p, splitErr := net.SplitHostPort(raw); splitErr == nil {
		host, port = h, p
	}
	if c.Port > 0 {
		port = strconv.Itoa(c.Port)
	}
	if port == "" {
		port = otlpDefaultGRPCPort
	}
	if host == "" {
		return "", false, fmt.Errorf("endpoint %q has no host", c.Endpoint)
	}
	return net.JoinHostPort(host, port), useInsecure, nil
}

// validateSIEMEndpoint checks the endpoint resolves for the configured
// transport, without sending anything.
func validateSIEMEndpoint(c siemConfig) error {
	if c.Protocol == siemProtocolGRPC {
		_, _, err := otlpGRPCTarget(c)
		return err
	}
	_, err := otlpEndpointURL(c)
	return err
}

// otlpResourceLogs builds the OTLP proto ResourceLogs for one audit event,
// from the same fields the HTTP/JSON path uses.
func otlpResourceLogs(e eventRecord, host string) []*logspb.ResourceLogs {
	tsNano, body, fields := otlpFields(e)
	kv := func(k, v string) *commonpb.KeyValue {
		return &commonpb.KeyValue{Key: k, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: v}}}
	}
	attrs := make([]*commonpb.KeyValue, 0, len(fields))
	for _, f := range fields {
		attrs = append(attrs, kv(f[0], f[1]))
	}
	return []*logspb.ResourceLogs{{
		Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{
			kv("service.name", "bailey"),
			kv("service.namespace", "bitswan"),
			kv("host.name", host),
		}},
		ScopeLogs: []*logspb.ScopeLogs{{
			Scope: &commonpb.InstrumentationScope{Name: "bailey.audit"},
			LogRecords: []*logspb.LogRecord{{
				TimeUnixNano:   uint64(tsNano),
				SeverityNumber: logspb.SeverityNumber_SEVERITY_NUMBER_INFO,
				SeverityText:   "INFO",
				Body:           &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: body}},
				Attributes:     attrs,
			}},
		}},
	}}
}

// exportOTLPGRPC sends one audit event over OTLP/gRPC (LogsService/Export).
func exportOTLPGRPC(ctx context.Context, c siemConfig, e eventRecord) error {
	target, useInsecure, err := otlpGRPCTarget(c)
	if err != nil {
		return err
	}
	var creds credentials.TransportCredentials
	if useInsecure {
		creds = insecure.NewCredentials()
	} else {
		creds = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})
	}
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(creds))
	if err != nil {
		return fmt.Errorf("dial %s: %w", target, err)
	}
	defer conn.Close()

	// A bearer token rides in gRPC metadata as the Authorization header, the
	// same convention collectors read for OTLP/gRPC.
	if t := strings.TrimSpace(c.AuthToken); t != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+t)
	}
	client := collogspb.NewLogsServiceClient(conn)
	req := &collogspb.ExportLogsServiceRequest{ResourceLogs: otlpResourceLogs(e, serverHostName())}
	if _, err := client.Export(ctx, req); err != nil {
		return fmt.Errorf("OTLP/gRPC export: %w", err)
	}
	return nil
}
