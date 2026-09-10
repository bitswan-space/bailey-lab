#!/usr/bin/env bash
# What the walkthrough cannot see.
#
# A green browser run says the product works. It says nothing about whether the
# namespace it works in is one a customer would accept: whether anything is
# privileged, whether the driver could act outside its namespace, whether the
# firewall that reports "monitoring" actually intercepts anything, whether the
# images running are the ones this cluster built. Each of those can be wrong
# while every chapter passes, so each is asserted here.
#
# Behaviour, not object existence, wherever behaviour is what matters — a
# NetworkPolicy that is accepted and not enforced fails open, and an object
# check would call that a pass.
set -uo pipefail

KUBECTL="${KUBECTL:-sudo k3s kubectl}"
NS="${E2E_K8S_NAMESPACE:-bitswan}"
failures=0

fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

check() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}

echo "=== nothing in the namespace can reach a container runtime ==="
# The guest does run docker, and that is not the question: it is how the images
# this cycle builds get into containerd, the way a CI runner builds them. The
# question is whether anything the Bailey runs can reach a runtime — which is
# what the Docker install's whole trust model rests on and what this one is
# supposed to replace. A socket would arrive as a host path, so it is the mount
# that is checked, not the binary.
sockets=$($KUBECTL -n "$NS" get pods -o json |
  python3 -c '
import json,sys
bad=[]
for p in json.load(sys.stdin)["items"]:
    for v in p["spec"].get("volumes") or []:
        path=(v.get("hostPath") or {}).get("path","")
        if "docker.sock" in path or "containerd" in path or "crio" in path:
            bad.append(p["metadata"]["name"] + ": " + path)
print("\n".join(bad))')
if [ -n "$sockets" ]; then
  fail "pods holding a container runtime socket:"$'\n'"$sockets"
else
  pass "no pod mounts a container runtime socket"
fi

echo "=== what PodSecurity is actually enforcing ==="
# Reported, not asserted. Baseline rejects NET_ADMIN, which the egress
# firewall's rule installer needs, and rejects the unconfined seccomp profile
# rootless buildkit needs — so a namespace that both builds images and enforces
# its own egress cannot carry that label, and there is no level between. The
# checks below are what actually holds the line; this line exists so nobody
# reads "baseline" somewhere and believes the API server is enforcing it.
level=$($KUBECTL get ns "$NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null)
echo "note: PodSecurity enforce=${level:-<unset>} on $NS — the assertions below, not this label, are the guarantee"

echo "=== nothing in the namespace is privileged or holds a socket ==="
priv=$($KUBECTL -n "$NS" get pods -o json |
  python3 -c '
import json,sys
bad=[]
for p in json.load(sys.stdin)["items"]:
    spec=p["spec"]
    name=p["metadata"]["name"]
    for key in ("hostNetwork","hostPID","hostIPC"):
        if spec.get(key): bad.append(name + ": " + key)
    for v in spec.get("volumes") or []:
        hp=(v.get("hostPath") or {}).get("path","")
        if hp: bad.append(name + ": hostPath " + hp)
    for c in (spec.get("containers") or []) + (spec.get("initContainers") or []):
        sc=c.get("securityContext") or {}
        if sc.get("privileged"): bad.append(name + "/" + c["name"] + ": privileged")
        for port in c.get("ports") or []:
            if port.get("hostPort"): bad.append(name + "/" + c["name"] + ": hostPort")
print("\n".join(bad))')
if [ -n "$priv" ]; then
  fail "privileged or host-bound workloads:"$'\n'"$priv"
else
  pass "no privileged container, host namespace, host path or host port"
fi

echo "=== NET_ADMIN exists only where the rules are written, and only until they are ==="
caps=$($KUBECTL -n "$NS" get pods -o json |
  python3 -c '
import json,sys
bad=[]
for p in json.load(sys.stdin)["items"]:
    for c in p["spec"].get("containers") or []:
        add=((c.get("securityContext") or {}).get("capabilities") or {}).get("add") or []
        if add: bad.append(p["metadata"]["name"] + "/" + c["name"] + ": " + str(add))
print("\n".join(bad))')
if [ -n "$caps" ]; then
  fail "app containers hold capabilities:"$'\n'"$caps"
else
  pass "no app container holds an added capability"
fi

echo "=== the driver can act in its namespace and nowhere else ==="
SA="system:serviceaccount:${NS}:bitswan-infra-driver"

# A query that did not run is not a denial. Asked with 2>/dev/null and matched
# on "yes", a kubectl that fails for any reason — wrong context, API server
# down, a typo in the resource name — answers "no" to every question, and five
# of the six checks below are looking for a no. They would all pass while
# proving nothing. So the three outcomes are kept apart.
# stdout only. Merging stderr looked like the careful thing to do and was the
# opposite: asking about a cluster-scoped resource prints "Warning: resource
# 'nodes' is not namespace scoped" first, so every such answer parsed as an
# error and the check reported that it could not be asked. The answer is on
# stdout and nothing else is; empty stdout is what "could not ask" looks like.
can() {
  local out
  out=$($KUBECTL auth can-i "$1" "$2" ${3:+-n "$3"} --as "$SA" 2>/dev/null | tail -1)
  case "$out" in
    yes) echo yes ;;
    no)  echo no ;;
    *)   echo unknown ;;
  esac
}

allowed() {
  local what="$1" verb="$2" res="$3" ns="${4:-}"
  case "$(can "$verb" "$res" "$ns")" in
    yes) pass "$what" ;;
    no)  fail "$what — refused" ;;
    *)   fail "$what — the question could not be asked" ;;
  esac
}

refused() {
  local what="$1" verb="$2" res="$3" ns="${4:-}"
  case "$(can "$verb" "$res" "$ns")" in
    no)  pass "$what" ;;
    yes) fail "$what — ALLOWED" ;;
    *)   fail "$what — the question could not be asked" ;;
  esac
}

allowed "driver may create deployments in $NS" create deployments "$NS"
refused "driver may not act in default" create deployments default
refused "driver may not list nodes" list nodes
refused "driver may not create namespaces" create namespaces
refused "driver may not write RBAC" create rolebindings "$NS"
refused "driver may not delete PVCs" delete persistentvolumeclaims "$NS"

echo "=== production runs two slots and exactly one is served ==="
slots=$($KUBECTL -n "$NS" get deploy -l gitops.stage=production \
  -o jsonpath='{range .items[*]}{.metadata.labels.gitops\.slot}{"\n"}{end}' 2>/dev/null | sort -u | grep -c .)
if [ "${slots:-0}" -ge 2 ]; then
  pass "production has $slots slots"
else
  fail "production has ${slots:-0} slot(s); a promotion has nowhere to go"
fi

echo "=== every business-process image came from this cluster's registry ==="
foreign=$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/managed-by=bitswan \
  -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' |
  grep -E '(^|/)internal/' | grep -v '^bitswan-registry:5000/' | sort -u)
if [ -n "$foreign" ]; then
  fail "built images not named in the namespace registry:"$'\n'"$foreign"
else
  pass "every built image is a registry reference"
fi

echo "=== a business process has a database of its own, and it is bound ==="
if $KUBECTL -n "$NS" get statefulset -l app.kubernetes.io/managed-by=bitswan 2>/dev/null |
   grep -q postgres; then
  pass "a Postgres statefulset exists"
  unbound=$($KUBECTL -n "$NS" get pvc -o jsonpath='{range .items[*]}{.metadata.name} {.status.phase}{"\n"}{end}' |
    grep -v ' Bound$' || true)
  [ -n "$unbound" ] && fail "unbound claims:"$'\n'"$unbound" || pass "every claim is bound"
else
  fail "no Postgres statefulset — the business process has no database"
fi

echo "=== a retired business process leaves no credentials behind ==="
orphans=$($KUBECTL -n "$NS" get secret,deploy -o json |
  python3 -c '
import json,sys
items=json.load(sys.stdin)["items"]
mounted=set()
for o in items:
    if o["kind"] != "Deployment":
        continue
    spec=o["spec"]["template"]["spec"]
    for c in (spec.get("containers") or []) + (spec.get("initContainers") or []):
        for ef in c.get("envFrom") or []:
            n=(ef.get("secretRef") or {}).get("name")
            if n:
                mounted.add(n)
orphans=[o["metadata"]["name"] for o in items
         if o["kind"] == "Secret"
         and (o["metadata"].get("labels") or {}).get("gitops.bp")
         and o["metadata"]["name"] not in mounted]
print("\n".join(sorted(orphans)))')
if [ -n "$orphans" ]; then
  fail "credential secrets outliving the workload that read them:"$'\n'"$orphans"
else
  pass "no credential secret outlives its workload"
fi

echo "=== the egress firewall actually intercepts ==="
# Behaviour, not object existence. In monitor mode the proxy records what was
# reached for, so a request from inside a firewalled pod has to show up in its
# attempts log — which is the only thing that distinguishes an installed rule
# from an installed rule that does nothing.
proxy=$($KUBECTL -n "$NS" get pods -l gitops.firewall_proxy=true -o name 2>/dev/null | head -1)
target=$($KUBECTL -n "$NS" get pods -l gitops.bp -o name 2>/dev/null |
  grep -v firewall | head -1)
if [ -z "$proxy" ] || [ -z "$target" ]; then
  fail "no firewall proxy or no firewalled workload to test through"
else
  # A name that resolves, deliberately. The interception is a destination
  # rewrite, so the client has to get as far as opening a connection — a name
  # that does not resolve produces no packet and the check would fail whether
  # or not the firewall works.
  probe_host="${E2E_EGRESS_PROBE_HOST:-example.com}"
  $KUBECTL -n "$NS" exec "$target" -- sh -c \
    "wget -q -T 4 -O /dev/null https://$probe_host/ 2>/dev/null || true" >/dev/null 2>&1
  sleep 3
  if $KUBECTL -n "$NS" exec "$proxy" -- sh -c \
      'cat /firewall/*.attempts.jsonl 2>/dev/null' 2>/dev/null | grep -q "$probe_host"; then
    pass "an outbound request from a workload was observed by the firewall"
  else
    fail "a request to $probe_host left a workload without the firewall seeing it"
  fi
fi

echo "=== the coding agent can reach gitops and nothing else ==="
# Behaviour, because a NetworkPolicy the CNI accepts and does not enforce fails
# OPEN, and an object check calls that a pass. The agent runs code its users and
# an AI wrote; its whole reachable surface is meant to be the authenticated
# gitops API. So it is asked to reach two things — one it must and one it must
# not — and a probe that cannot be run at all is a failure, not a silent pass.
agent=$($KUBECTL -n "$NS" get pods -l bitswan.io/role=coding-agent -o name 2>/dev/null | head -1)
if [ -z "$agent" ]; then
  fail "no coding-agent pod to test isolation against"
else
  # Whatever the image happens to carry. The agent has no nc, which the first
  # version of this check treated as "cannot test" — so a policy that was not
  # enforced would have been reported as untestable rather than as open.
  reach() {
    $KUBECTL -n "$NS" exec "$agent" -- sh -c "
      if command -v bash >/dev/null; then
        timeout 4 bash -c 'exec 3<>/dev/tcp/$1/$2' && exit 0 || exit 1
      elif command -v python3 >/dev/null; then
        python3 -c 'import socket,sys; s=socket.create_connection((\"$1\",$2),4); s.close()' && exit 0 || exit 1
      elif command -v nc >/dev/null; then
        nc -z -w 3 $1 $2 && exit 0 || exit 1
      fi
      exit 2" >/dev/null 2>&1
    case $? in 0) echo reached ;; 2) echo unknown ;; *) echo blocked ;; esac
  }
  gitops_host=$($KUBECTL -n "$NS" get svc -o name 2>/dev/null | grep -- '-gitops$' | head -1 | cut -d/ -f2)
  dash_host=$($KUBECTL -n "$NS" get svc -o name 2>/dev/null | grep -- '-dashboard$' | head -1 | cut -d/ -f2)
  case "$(reach "$gitops_host" 8079)" in
    reached) pass "the agent reaches gitops" ;;
    blocked) fail "the agent cannot reach gitops — the policy is too tight to work" ;;
    *)       fail "could not test whether the agent reaches gitops" ;;
  esac
  case "$(reach "$dash_host" 8080)" in
    blocked) pass "the agent cannot reach the dashboard" ;;
    reached) fail "the agent REACHES the dashboard — the isolation policy is not enforced" ;;
    *)       fail "could not test whether the agent reaches the dashboard" ;;
  esac
fi

echo "=== the features that exist on Docker exist here ==="
# Three times a namespace implementation has been written and its call site
# left gated to Docker, and each time every chapter stayed green because the
# chapters navigate and capture rather than assert. These check the EFFECT, in
# the place a person would look: a database with something in it, and a page
# that answers.
gitops_pod=$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/name -o name 2>/dev/null |
  grep -- '-gitops' | head -1)
if [ -z "$gitops_pod" ]; then
  fail "no gitops pod to check the vulnerability database in"
else
  if $KUBECTL -n "$NS" exec "$gitops_pod" -- sh -c \
      'test -d /grype-db && [ -n "$(ls -A /grype-db 2>/dev/null)" ]' >/dev/null 2>&1; then
    pass "the shared vulnerability database is populated and readable by gitops"
  else
    fail "gitops sees no vulnerability database — every CVE scan reports the image unscanned"
  fi
fi

# The resources API sits behind the device-trust gate, so this cannot ask it
# without a session — and faking one to satisfy a check would be worse than not
# checking. Two things it can observe honestly instead: that the namespace has
# a budget at all, since without one the page has nothing to report; and that
# the governor is not failing to take an inventory, which is the symptom that
# had it erroring every five minutes while every chapter stayed green.
quota=$($KUBECTL -n "$NS" get resourcequota -o jsonpath='{.items[0].status.hard.requests\.memory}' 2>/dev/null)
if [ -n "$quota" ]; then
  pass "the namespace has a memory budget ($quota)"
else
  fail "the namespace has no memory quota — the governor has no ceiling and the admin page nothing to show"
fi

inv=$($KUBECTL -n "$NS" logs deploy/bailey -c daemon --tail=2000 2>/dev/null |
  grep -cE 'memory sweep: inventory failed|memory admission check failed' || true)
if [ "${inv:-0}" -gt 0 ]; then
  fail "the memory governor failed to take an inventory ${inv} time(s) — see the daemon log"
else
  pass "the memory governor is taking inventories"
fi

echo "=== nothing crash-looped ==="
restarts=$($KUBECTL -n "$NS" get pods \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' |
  awk '{s=0; for(i=2;i<=NF;i++) s+=$i; if (s>0) print $1" restarted "s" time(s)"}')
if [ -n "$restarts" ]; then
  fail "restarts during the run:"$'\n'"$restarts"
else
  pass "no container restarted"
fi
looping=$($KUBECTL -n "$NS" get pods --no-headers | grep -c CrashLoopBackOff || true)
[ "${looping:-0}" -gt 0 ] && fail "$looping pod(s) in CrashLoopBackOff" || pass "nothing in CrashLoopBackOff"

echo
if [ "$failures" -gt 0 ]; then
  echo "SHAPE: $failures check(s) failed" >&2
  exit 1
fi
echo "SHAPE: every check passed"
