#!/bin/sh
# Fixed read-only Vera deployment probe. It must never mutate the target host.

set +e
set -f
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin
export PATH

emit() {
  key=$1
  shift
  value=$*
  printf '%s\t%s\n' "$key" "$value"
}

emit schema vera-preflight-v1
probe_os=$(uname -s 2>/dev/null)
if [ "$probe_os" = Darwin ]; then
  PATH=$PATH:/opt/homebrew/bin:/opt/homebrew/sbin
  export PATH
fi
case "$probe_os" in
  Linux|Darwin) emit os "$probe_os" ;;
  *) emit os unsupported ;;
esac
probe_arch=$(uname -m 2>/dev/null)
case "$probe_arch" in
  x86_64|amd64) emit arch x86_64 ;;
  arm64|aarch64) emit arch arm64 ;;
  *) emit arch unsupported ;;
esac
emit epoch "$(date +%s 2>/dev/null)"

if command -v node >/dev/null 2>&1; then
  emit node "$(node --version 2>/dev/null)"
else
  emit node missing
fi

if command -v systemctl >/dev/null 2>&1; then
  systemd_state=$(systemctl is-system-running 2>/dev/null)
  case "$systemd_state" in
    running|degraded)
      emit systemd "$systemd_state"
      service_output=$(systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null)
      if [ "$?" -eq 0 ]; then
        emit serviceScan available
        printf '%s\n' "$service_output" \
          | awk '$1 ~ /^(vera|cloudflared|nginx|caddy).*\.service$/ { print $1 "|" $2 }' \
          | while IFS= read -r service; do emit service "$service"; done
      else
        emit serviceScan unavailable
      fi
      ;;
    *)
      emit systemd unavailable
      emit serviceScan unavailable
      ;;
  esac
else
  emit systemd unavailable
  emit serviceScan unavailable
fi

if command -v tailscale >/dev/null 2>&1; then
  emit tailscaleInstalled yes
  if tailscale status >/dev/null 2>&1; then
    emit tailscaleActive yes
  else
    emit tailscaleActive no
  fi
  serve_status=$(tailscale serve status 2>/dev/null)
  if [ "$?" -ne 0 ]; then
    emit tailscaleServe unavailable
  elif [ -n "$serve_status" ] && ! printf '%s' "$serve_status" | grep -qi 'no serve config'; then
    emit tailscaleServe configured
  else
    emit tailscaleServe absent
  fi
else
  emit tailscaleInstalled no
  emit tailscaleActive no
  emit tailscaleServe unavailable
fi

if command -v ss >/dev/null 2>&1; then
  listener_output=$(ss -H -ltn 2>/dev/null)
  if [ "$?" -eq 0 ]; then
    emit listenerScan available
    printf '%s\n' "$listener_output" | awk 'NF > 0 { print $4 }' \
      | while IFS= read -r listener; do emit listener "$listener"; done
  else
    emit listenerScan unavailable
  fi
elif command -v netstat >/dev/null 2>&1; then
  listener_output=$(netstat -an -p tcp 2>/dev/null)
  if [ "$?" -eq 0 ]; then
    emit listenerScan available
    printf '%s\n' "$listener_output" | awk '$6 == "LISTEN" { print $4 }' \
      | while IFS= read -r listener; do emit listener "$listener"; done
  else
    emit listenerScan unavailable
  fi
else
  emit listenerScan unavailable
fi

role=$1
shift
emit role "$role"
while [ "$#" -ge 2 ]; do
  path_name=$1
  target_path=$2
  shift 2

  existing_path=$target_path
  while [ ! -e "$existing_path" ] && [ "$existing_path" != / ]; do
    existing_path=${existing_path%/*}
    [ -n "$existing_path" ] || existing_path=/
  done

  if [ -d "$target_path" ]; then
    path_kind=directory
  elif [ -e "$target_path" ]; then
    path_kind=other
  else
    path_kind=missing
  fi
  path_symlink=no
  scan_path=/
  old_ifs=$IFS
  IFS=/
  for component in ${target_path#/}; do
    [ -n "$component" ] || continue
    if [ "$scan_path" = / ]; then scan_path=/$component; else scan_path=$scan_path/$component; fi
    if [ -L "$scan_path" ]; then path_symlink=yes; break; fi
    [ -e "$scan_path" ] || break
  done
  IFS=$old_ifs
  if [ -w "$existing_path" ]; then path_writable=yes; else path_writable=no; fi
  emit path "$path_name|$target_path|$path_kind|$path_writable|$path_symlink"

  disk_kb=$(df -Pk "$existing_path" 2>/dev/null | awk 'NR == 2 { print $4 }')
  if [ -n "$disk_kb" ]; then emit disk "$path_name|$disk_kb"; else emit disk "$path_name|unknown"; fi
done

exit 0
