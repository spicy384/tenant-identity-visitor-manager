#!/usr/bin/env bash
# Seals the database key to this machine's TPM with systemd-creds, and runs the app from a
# systemd service that unseals it as it starts. See README, "Database key sealed to the TPM".
#
#   sudo bash deploy/tpm/setup.sh check                 what this host has, and what's missing
#   sudo bash deploy/tpm/setup.sh seal [options] [FILE] seal the key (default secrets/db_key)
#        --pcrs 7|none|LIST   bind to these TPM PCRs (default 7, the Secure Boot state)
#        --remove             delete FILE once it is sealed and checked
#        -                    read the key from the keyboard (or a pipe) instead of a file
#   sudo bash deploy/tpm/setup.sh install               install and start the systemd service
#   sudo bash deploy/tpm/setup.sh status                the service, and whether the key unseals
#   sudo bash deploy/tpm/setup.sh uninstall             stop and remove the service (keeps the sealed key)
#
# Needs systemd 250 or later (Debian 12+, Ubuntu 24.04+), a TPM 2.0, and Docker Compose v2.
set -euo pipefail

NAME=identity-visitor-manager
CRED_DIR=/etc/$NAME
CRED=$CRED_DIR/db_key.cred
UNIT=/etc/systemd/system/$NAME.service
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPDIR=$(cd "$HERE/../.." && pwd)
SELF="sudo bash $HERE/setup.sh"

die() { echo "error: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run this with sudo"; }
systemd_version() { systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }' | sed 's/[^0-9].*//'; }

# --- check ---------------------------------------------------------------------------------

cmd_check() {
  local ok=1 v
  v=$(systemd_version)
  if [ "${v:-0}" -ge 250 ]; then
    echo "systemd $v: has systemd-creds"
  else
    echo "systemd ${v:-?}: too old; needs 250 or later (Debian 12+, Ubuntu 24.04+)"
    ok=0
  fi
  if command -v systemd-creds >/dev/null 2>&1 && systemd-creds has-tpm2 >/dev/null 2>&1; then
    echo "TPM 2.0: ready"
  else
    echo "TPM 2.0: not fully usable. systemd-creds says:"
    (systemd-creds has-tpm2 2>&1 || true) | sed 's/^/    /'
    echo "    No TPM: on a VM, add a virtual TPM. TPM libraries missing: sudo apt install tpm2-tools"
    ok=0
  fi
  if command -v mokutil >/dev/null 2>&1; then
    echo "Secure Boot: $(mokutil --sb-state 2>/dev/null | head -n 1)"
  fi
  if docker compose version >/dev/null 2>&1; then
    echo "Docker Compose: $(docker compose version --short)"
  else
    echo "Docker Compose v2: not found"
    ok=0
  fi
  if [ -f "$CRED" ]; then echo "Sealed key: $CRED"; else echo "Sealed key: none yet ($SELF seal)"; fi
  if [ -f "$UNIT" ]; then echo "Service: installed ($(systemctl is-active "$NAME.service" 2>/dev/null || true))"; else echo "Service: not installed"; fi
  [ "$ok" -eq 1 ]
}

# --- seal ----------------------------------------------------------------------------------

cmd_seal() {
  need_root
  local pcrs=7 src="" remove=0 key
  while [ $# -gt 0 ]; do
    case "$1" in
      --pcrs) pcrs=${2:?--pcrs takes 7, none, or a list such as 7+14}; shift 2 ;;
      --remove) remove=1; shift ;;
      -) src=-; shift ;;
      -*) die "unknown option $1" ;;
      *) src=$1; shift ;;
    esac
  done
  [ -n "$src" ] || src="$APPDIR/secrets/db_key"
  command -v systemd-creds >/dev/null 2>&1 || die "systemd-creds not found; needs systemd 250 or later ($SELF check)"

  if [ "$src" = - ]; then
    [ "$remove" -eq 0 ] || die "--remove needs a key file"
    if [ -t 0 ]; then
      read -rsp "Database key (64 hex characters, not shown): " key
      echo
    else
      read -r key
    fi
  else
    [ -r "$src" ] || die "can't read $src"
    key=$(tr -d '[:space:]' < "$src")
  fi
  [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]] || die "that isn't a database key (64 hex characters)"
  key=${key,,}

  local pcrarg=()
  [ "$pcrs" = none ] || pcrarg=(--tpm2-pcrs="$pcrs")
  install -d -m 0700 "$CRED_DIR"
  local tmp="$CRED.new"
  # printf is a shell builtin: the key never appears in a process list.
  printf '%s' "$key" | systemd-creds encrypt --name=db_key --with-key=tpm2 ${pcrarg[@]+"${pcrarg[@]}"} - "$tmp"
  chmod 0600 "$tmp"
  # Check it unseals to the same key before replacing anything.
  if [ "$(systemd-creds decrypt --name=db_key "$tmp" - 2>/dev/null)" != "$key" ]; then
    rm -f "$tmp"
    die "the sealed key didn't unseal back to the same key; nothing was changed"
  fi
  mv -f "$tmp" "$CRED"
  key=""
  echo "Sealed to this machine's TPM: $CRED (PCRs: $pcrs)."

  if [ "$src" != - ]; then
    if [ "$remove" -eq 1 ]; then
      if command -v shred >/dev/null 2>&1; then shred -u "$src"; else rm -f "$src"; fi
      echo "Removed $src. (On an SSD the old blocks may survive deletion; full-disk encryption covers that.)"
    else
      echo "The plain key is still in $src. Remove it once the service runs: shred -u $src"
    fi
  fi
  echo "Keep the key in your password manager: a new machine, a new motherboard or a firmware"
  echo "change can stop this sealed copy unsealing, and only the key itself restores it."
  if [ -f "$UNIT" ]; then echo "Restart to use it: sudo systemctl restart $NAME"; fi
}

# --- install / status / uninstall ----------------------------------------------------------

cmd_install() {
  need_root
  [ -f "$CRED" ] || die "seal the key first: $SELF seal"
  [ -f "$APPDIR/docker-compose.yml" ] || die "no docker-compose.yml in $APPDIR"
  # The folder goes into the unit through sed, where | and & mean something.
  case "$APPDIR" in *"|"* | *"&"*) die "the app's folder can't contain | or &" ;; esac
  local docker
  docker=$(command -v docker) || die "docker not found"
  cd "$APPDIR"
  # Installing again: stop the running service first. And the plain-key setup must not
  # run alongside it.
  if [ -f "$UNIT" ]; then systemctl stop "$NAME.service" || true; fi
  if [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
    echo "Stopping the containers started without the service..."
    docker compose down
  fi
  if ! docker image inspect identity-visitor-manager:latest >/dev/null 2>&1; then
    echo "Building the image..."
    docker compose build
  fi
  sed -e "s|@APPDIR@|$APPDIR|g" -e "s|@DOCKER@|$docker|g" "$HERE/$NAME.service.in" > "$UNIT"
  chmod 0644 "$UNIT"
  systemctl daemon-reload
  systemctl enable --now "$NAME.service"
  echo "Installed and started $NAME.service."
  echo "  Logs:            journalctl -u $NAME -f"
  echo "  After an update: docker compose build && sudo systemctl restart $NAME"
  if [ -f "$APPDIR/secrets/db_key" ]; then echo "  Then remove the plain key: shred -u $APPDIR/secrets/db_key"; fi
}

cmd_status() {
  systemctl --no-pager status "$NAME.service" || true
  if [ ! -f "$CRED" ]; then
    echo "Sealed key: none"
  elif [ "$(id -u)" -ne 0 ]; then
    echo "Sealed key: $CRED (run with sudo to check it unseals)"
  elif systemd-creds decrypt --name=db_key "$CRED" - >/dev/null 2>&1; then
    echo "Sealed key: unseals on this machine"
  else
    echo "Sealed key: does NOT unseal. After a firmware or Secure Boot change, seal it again"
    echo "from your password manager: $SELF seal -   then: sudo systemctl restart $NAME"
  fi
}

cmd_uninstall() {
  need_root
  if [ -f "$UNIT" ]; then
    systemctl disable --now "$NAME.service" || true
    rm -f "$UNIT"
    systemctl daemon-reload
    echo "Removed $NAME.service."
  else
    echo "The service isn't installed."
  fi
  echo "The sealed key stays in $CRED. To go back to a plain key file, put the key in"
  echo "$APPDIR/secrets/db_key (chown 1000:1000, chmod 400) and run docker compose up -d."
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  seal) shift; cmd_seal "$@" ;;
  install) shift; cmd_install "$@" ;;
  status) shift; cmd_status "$@" ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  *) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
