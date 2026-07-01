projectname?=bitswan

# Bailey Server Console (SPA) — built separately and baked into the daemon
# binary via `go:embed serverconsole_dist`. CONSOLE_DIR points at the sibling
# package in the monorepo; CONSOLE_EMBED is the embed dir the binary compiles in.
CONSOLE_DIR?=../bitswan-server-console
CONSOLE_EMBED:=internal/daemon/serverconsole_dist

# Per-BP egress firewall gateway image. The daemon's Go infra-driver GENERATES
# the gateway's docker-compose spec (internal/infradriver/dockerdriver), so the
# binary and this image are two halves of one contract and must be built from
# the same source — a stale image against a newer spec crash-loops the gateway
# and fails every deploy (e.g. the owner/proxy split expects a role-aware
# entrypoint the pre-split image doesn't have). Keep this tag in sync with the
# driver's BITSWAN_EGRESS_GATEWAY_IMAGE default (compile.go).
EGRESS_GATEWAY_IMAGE?=bitswan/egress-gateway:latest

default: help

.PHONY: help
help: ## list makefile targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.PHONY: console
console: ## build the Server Console SPA and stage it for go:embed
	# Always reconcile deps: a no-op when the tree is in sync, but it picks up
	# packages newly added to package.json so the bundle is never stale.
	# --prefer-offline uses the npm cache when possible (only new/missing
	# packages hit the network), keeping the common case fast.
	npm --prefix "$(CONSOLE_DIR)" install --no-audit --no-fund --prefer-offline
	npm --prefix "$(CONSOLE_DIR)" run build
	@rm -rf "$(CONSOLE_EMBED)"
	@mkdir -p "$(CONSOLE_EMBED)"
	@cp -r "$(CONSOLE_DIR)/dist/." "$(CONSOLE_EMBED)/"
	@touch "$(CONSOLE_EMBED)/.gitkeep"

.PHONY: egress-gateway
egress-gateway: ## build the per-BP egress firewall gateway image (must track the daemon's infra-driver spec)
	docker build -f cmd/egress-gateway/Dockerfile -t $(EGRESS_GATEWAY_IMAGE) .

.PHONY: build
build: console egress-gateway ## build golang binary (Console SPA embedded) + the matching egress-gateway image
	@CGO_ENABLED=0 go build \
		-ldflags "-X main.version=$(shell git describe --abbrev=0 --tags) -w -s -extldflags '-static'" \
		-a \
		-o $(projectname)

.PHONY: install
install: ## install golang binary
	@go install -ldflags "-X main.version=$(shell git describe --abbrev=0 --tags)"

.PHONY: run
run: ## run the app
	@go run -ldflags "-X main.version=$(shell git describe --abbrev=0 --tags)"  main.go

.PHONY: bootstrap
bootstrap: ## install build deps
	go generate -tags tools tools/tools.go

PHONY: test
test: clean ## display test coverage
	go test --cover -parallel=1 -v -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out | sort -rnk3
	
PHONY: clean
clean: ## clean up environment
	@rm -rf coverage.out dist/ $(projectname)

PHONY: cover
cover: ## display test coverage
	go test -v -race $(shell go list ./... | grep -v /vendor/) -v -coverprofile=coverage.out
	go tool cover -func=coverage.out

PHONY: fmt
fmt: ## format go files
	gofumpt -w .
	gci write .

PHONY: lint
lint: ## lint go files
	golangci-lint run -c .golang-ci.yml

.PHONY: pre-commit
pre-commit:	## run pre-commit hooks
	pre-commit run --all-files

