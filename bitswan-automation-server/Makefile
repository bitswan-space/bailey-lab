projectname?=bitswan

# Bailey Server Console (SPA) — built separately and baked into the daemon
# binary via `go:embed serverconsole_dist`. CONSOLE_DIR points at the sibling
# package in the monorepo; CONSOLE_EMBED is the embed dir the binary compiles in.
CONSOLE_DIR?=../bitswan-server-console
CONSOLE_EMBED:=internal/daemon/serverconsole_dist
# The Operator's Handbook lives in the console's public/ dir, from where vite
# copies it into dist/ and go:embed bakes it into the binary. MANUAL_DIR is the
# generator that writes it.
MANUAL_DIR?=../e2e/manual
HANDBOOK_HTML:=$(CONSOLE_DIR)/public/handbook/handbook.html

default: help

.PHONY: help
help: ## list makefile targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

# The handbook is GENERATED, never committed (it is ~20 MB of inlined
# screenshots). The release workflow bakes the real one — HTML + PDF, with live
# product captures — from the E2E's `operators-handbook` artifact. Any other
# build had nothing, so the console shipped a Handbook page with no handbook
# behind it.
#
# There is no need for that. The generator reads its editorial content from the
# repo and only the SCREENSHOTS come from the walkthrough: with none available
# it renders every capture slot as an honest "capture pending" placeholder, in
# about a second, with no browser and no running product. So a build with no
# baked handbook gets that one instead of getting nothing.
#
# The two flags keep it dependency-free: MANUAL_NO_PDF=1 skips the print render
# (headless Chromium — the slow part, and the only part needing Playwright), and
# MANUAL_NO_PAGED=1 skips inlining the Paged.js polyfill (an e2e dependency;
# pagination is presentation, not content). So this runs with nothing installed
# but node. Such a build carries HTML and no PDF, and handbookFormats() in the
# daemon reports exactly that, so the console offers the one link that works.
#
# Skipped when a handbook is already staged — the release workflow's baked one
# must win over a screenshot-less stub.
.PHONY: handbook-stub
handbook-stub: ## generate a screenshot-less handbook when none is staged
	@if [ -f "$(HANDBOOK_HTML)" ]; then \
		echo "handbook already staged ($(HANDBOOK_HTML)) — keeping it"; \
	else \
		echo "no handbook staged — generating one without screenshots"; \
		MANUAL_NO_PDF=1 MANUAL_NO_PAGED=1 node "$(MANUAL_DIR)/generate.mjs"; \
	fi

.PHONY: console
console: handbook-stub ## build the Server Console SPA and stage it for go:embed
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

.PHONY: build
build: console ## build golang binary with the Server Console SPA embedded
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

