SHELL := /usr/bin/bash
.DEFAULT_GOAL := help

COMPOSE := docker compose
COMPOSE_BASE := -f docker-compose.yml
COMPOSE_DEV := $(COMPOSE_BASE) -f docker-compose.dev.yml
COMPOSE_PROD := $(COMPOSE_BASE) -f docker-compose.prod.yml
ENV_FILE ?= .env
USER = marwa
PYTHON := .venv/bin/python
PYTHON_READY := .venv/.requirements-ready

.PHONY: help secrets certs python-deps config format check images supply-chain up down reset logs ldap-test identity-test api-test web-test browser-test job-test observability-test matrix-test matrix-evidence test offboard restore measure bench export

help: ## Show the canonical project commands
	@awk 'BEGIN {FS = ":.*## "; printf "IAM Access Revocation Lab\n\nUsage:\n  make <target>\n\nTargets:\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

secrets: ## Generate missing local secrets in .env without overwriting real values
	@./scripts/gen-secrets.sh "$(ENV_FILE)"

certs: ## Generate trusted mkcert certificates for the local HTTPS hostnames
	@./scripts/gen-certs.sh

config: ## Validate the base, development, and production-style Compose models
	@$(COMPOSE) $(COMPOSE_BASE) config --quiet
	@$(COMPOSE) $(COMPOSE_DEV) config --quiet
	@$(COMPOSE) $(COMPOSE_PROD) config --quiet

$(PYTHON_READY): tests/requirements.txt
	@python3 -m venv .venv
	@$(PYTHON) -m pip install --disable-pip-version-check --requirement tests/requirements.txt
	@$(PYTHON) -c 'from pathlib import Path; Path("$(PYTHON_READY)").touch()'

python-deps: $(PYTHON_READY) ## Install the pinned experiment and evidence toolchain


format: python-deps ## Format TypeScript/Python sources and check repository whitespace
	@npm --prefix services/api run format
	@npm --prefix services/webapp run format
	@npm --prefix services/job run format
	@$(PYTHON) -m ruff format services/offboarding tests
	@git diff --check
	@git diff --cached --check

check: python-deps ## Run the complete repository validation floor
	@./scripts/validate-bootstrap.sh
	@npm --prefix services/api run check
	@npm --prefix services/webapp run check
	@npm --prefix services/job run check
	@$(PYTHON) -m ruff check services/offboarding tests
	@$(PYTHON) -m pytest
	@$(PYTHON) -m tests.prometheus_rules --check
	@$(PYTHON) -m tests.workflow_policy
	@$(PYTHON) -m tests.report_metrics --check

images: ## Build the three project-owned runtime images
	@docker build --tag iam-lab-api:ci services/api
	@docker build --tag iam-lab-webapp:ci services/webapp
	@docker build --tag iam-lab-job:ci services/job

supply-chain: images ## Scan Git history, lockfiles, and project images for secrets/vulnerabilities
	@./scripts/supply-chain.sh

up: secrets ## Start identity, API validation modes, revocation store, and HTTPS edge
	@./scripts/require-certs.sh
	@$(COMPOSE) $(COMPOSE_DEV) up -d --wait ldap postgres
	@$(COMPOSE) $(COMPOSE_DEV) run --rm ldap-seed
	@$(COMPOSE) $(COMPOSE_DEV) up -d --wait keycloak
	@$(COMPOSE) $(COMPOSE_DEV) run --rm keycloak-config
	@$(COMPOSE) $(COMPOSE_DEV) up -d --build --wait not-before-store api-local api-introspection api-cached-introspection
	@$(COMPOSE) $(COMPOSE_DEV) up -d --build --wait webapp job
	@$(COMPOSE) $(COMPOSE_DEV) up -d --wait prometheus grafana
	@$(COMPOSE) $(COMPOSE_DEV) up -d --wait traefik

down: ## Stop the development stack without deleting persistent data
	@$(COMPOSE) $(COMPOSE_DEV) down --remove-orphans

reset: ## Delete local runtime data only with CONFIRM=reset
	@test "$(CONFIRM)" = reset || { printf '%s\n' 'Refusing destructive reset. Re-run with CONFIRM=reset after explicit operator approval.' >&2; exit 2; }
	@$(COMPOSE) $(COMPOSE_DEV) down --volumes --remove-orphans

logs: ## Follow logs for identity, API, web, job, revocation, and edge services
	@$(COMPOSE) $(COMPOSE_DEV) logs --follow ldap postgres keycloak not-before-store api-local api-introspection api-cached-introspection webapp job prometheus grafana traefik

ldap-test: ## Prove LDAP persistence, least privilege, membership, and lockout
	@./scripts/test-ldap.sh

identity-test: ## Prove HTTPS routing, realm policy, LDAP claims, and client credentials
	@./scripts/test-identity.sh

api-test: ## Prove the shared authorization policy across all validation modes
	@./scripts/test-api.sh

web-test: ## Prove console tests, HTTPS delivery, security headers, and exact-origin CORS
	@./scripts/test-webapp.sh

browser-test: secrets ## Prove the complete trusted-browser PKCE, refresh, and logout flow
	@set -a; source ./.env; set +a; npm --prefix services/webapp run browser:smoke

job-test: ## Prove scheduled job token caching, report calls, and secret-safe logs
	@./scripts/test-job.sh

observability-test: matrix-test ## Prove Prometheus targets, bounded metrics, and provisioned Grafana dashboards
	@./scripts/test-observability.sh

matrix-test: python-deps ## Run the external profile-by-route-by-mode authorization matrix
	@$(PYTHON) tests/test_matrix.py --output results/raw/matrix-latest.csv

matrix-evidence: python-deps ## Publish a passing authorization matrix as canonical evidence
	@$(PYTHON) tests/test_matrix.py

test: api-test web-test job-test observability-test ## Run the complete authorization, workload, and observability proof

offboard: secrets python-deps ## Offboard USER=<username> with timestamped retry-safe mutations
	@$(PYTHON) -m services.offboarding.cli --user "$(USER)" --mode automated --phase full

restore: secrets python-deps ## Restore the designated offboarding subject after a demo
	@$(PYTHON) -m services.offboarding.cli --user "$(USER)" --mode automated --phase restore

measure: python-deps ## Run the 1/5/15-minute baseline and automated offboarding experiment
	@$(PYTHON) tests/offboarding_run.py

bench: python-deps ## Benchmark all token-validation modes with fixed load
	@$(PYTHON) tests/bench.py

export: python-deps ## Validate canonical evidence and regenerate deterministic charts
	@$(PYTHON) tests/validate_results.py
	@$(PYTHON) tests/plots.py
	@$(PYTHON) -m tests.prometheus_rules
	@$(PYTHON) -m tests.report_metrics
