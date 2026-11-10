#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"

trivy_image='aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
gitleaks_image='ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'
trivy_cache_volume='iam-access-revocation-trivy-cache'
project_images=(iam-lab-api:ci iam-lab-webapp:ci iam-lab-job:ci)

command -v docker >/dev/null 2>&1 || {
  printf '%s\n' 'Missing required command: docker.' >&2
  exit 2
}
git -C "${repo_root}" rev-parse --is-inside-work-tree >/dev/null

docker volume create "${trivy_cache_volume}" >/dev/null

printf '%s\n' 'Scanning complete Git history with Gitleaks...'
docker run --rm \
  --volume "${repo_root}:/repo:ro" \
  --workdir /repo \
  "${gitleaks_image}" \
  git --redact --no-banner --no-color --timeout 300 /repo

printf '%s\n' 'Scanning dependency manifests and lockfiles with Trivy...'
docker run --rm \
  --volume "${repo_root}:/repo:ro" \
  --volume "${trivy_cache_volume}:/root/.cache/trivy" \
  "${trivy_image}" \
  --timeout 15m \
  --db-repository ghcr.io/aquasecurity/trivy-db:2 \
  fs \
  --scanners vuln \
  --severity HIGH,CRITICAL \
  --include-dev-deps \
  --ignore-unfixed \
  --exit-code 1 \
  --no-progress \
  --report summary \
  --skip-dirs /repo/.venv \
  --skip-dirs /repo/infra/certs \
  --skip-dirs /repo/node_modules \
  --skip-dirs /repo/results/raw \
  /repo

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "${temp_dir}"' EXIT

for image_name in "${project_images[@]}"; do
  docker image inspect "${image_name}" >/dev/null 2>&1 || {
    printf 'Missing project image %s. Run make images first.\n' "${image_name}" >&2
    exit 2
  }
  if docker run --rm --entrypoint sh "${image_name}" -c \
    'command -v npm >/dev/null 2>&1 || command -v npx >/dev/null 2>&1'; then
    printf 'Production image %s unexpectedly contains npm or npx.\n' "${image_name}" >&2
    exit 1
  fi
  archive_name="${image_name//:/-}"
  archive_name="${archive_name//\//-}.tar"
  printf 'Scanning project image %s with Trivy...\n' "${image_name}"
  docker save --output "${temp_dir}/${archive_name}" "${image_name}"
  docker run --rm \
    --volume "${temp_dir}:/images:ro" \
    --volume "${trivy_cache_volume}:/root/.cache/trivy" \
    "${trivy_image}" \
    --timeout 15m \
    --db-repository ghcr.io/aquasecurity/trivy-db:2 \
    image \
    --input "/images/${archive_name}" \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    --exit-code 1 \
    --no-progress \
    --report summary
  rm -- "${temp_dir}/${archive_name}"
done

printf '%s\n' 'Supply-chain acceptance passed: no Git leaks or fixed HIGH/CRITICAL dependency/image vulnerabilities.'
