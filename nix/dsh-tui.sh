#!/bin/sh
set -eu

profile_name=deepseek-harness-tui
if [ -n "${DSH_HOME:-}" ]; then
  dsh_home=$DSH_HOME
else
  : "${HOME:?HOME must be set when DSH_HOME is unset}"
  dsh_home=$HOME/.dsh
fi
profile_dir="$dsh_home/profiles/$profile_name"
template_dir="@out@/share/dsh/profiles/$profile_name"
template_version="@profileVersion@"
owner_file="$profile_dir/.managed-by-deepseek-harness-tui"
owner_marker=deepseek-harness-tui-profile-v1
version_file="$profile_dir/.nix-package-version"

install_profile_file() {
  source_file=$1
  destination_file=$2
  temporary_file=$destination_file.tmp.$$
  cp "$source_file" "$temporary_file"
  chmod u+w "$temporary_file"
  mv -f "$temporary_file" "$destination_file"
}

install_marker() {
  destination_file=$1
  value=$2
  temporary_file=$destination_file.tmp.$$
  printf '%s\n' "$value" > "$temporary_file"
  mv -f "$temporary_file" "$destination_file"
}

profile_is_owned() {
  [ -f "$owner_file" ] || return 1
  IFS= read -r installed_owner < "$owner_file" || return 1
  [ "$installed_owner" = "$owner_marker" ]
}

managed_profile_exists() {
  for file in package.json cordis.yml pnpm-workspace.yaml; do
    [ ! -e "$profile_dir/$file" ] && [ ! -L "$profile_dir/$file" ] || return 0
  done
  return 1
}

seed_profile() {
  mkdir -p "$profile_dir"
  install_marker "$owner_file" "$owner_marker"
  for file in package.json cordis.yml pnpm-workspace.yaml; do
    install_profile_file "$template_dir/$file" "$profile_dir/$file"
  done
  if [ ! -e "$profile_dir/cordis.patch.yml" ] && [ ! -L "$profile_dir/cordis.patch.yml" ]; then
    temporary_patch=$profile_dir/.cordis.patch.yml.tmp.$$
    cp "$template_dir/cordis.patch.yml" "$temporary_patch"
    chmod u+w "$temporary_patch"
    if ! ln "$temporary_patch" "$profile_dir/cordis.patch.yml" 2>/dev/null; then
      if [ ! -e "$profile_dir/cordis.patch.yml" ] && [ ! -L "$profile_dir/cordis.patch.yml" ]; then
        rm -f "$temporary_patch"
        return 1
      fi
    fi
    rm -f "$temporary_patch"
  fi
  install_marker "$version_file" "$template_version"
}

if ! profile_is_owned && managed_profile_exists; then
  printf '%s\n' "dsh-tui: refusing to replace unowned profile $profile_dir" >&2
  exit 1
fi

if [ "${DSH_TUI_RESET_PROFILE:-0}" = 1 ] || [ ! -f "$profile_dir/package.json" ]; then
  seed_profile
else
  installed_version=unversioned
  if [ -f "$version_file" ]; then
    IFS= read -r installed_version < "$version_file" || installed_version=unversioned
  fi
  if [ "$installed_version" != "$template_version" ]; then
    printf '%s\n' "dsh-tui: profile template is $installed_version; set DSH_TUI_RESET_PROFILE=1 once to install template $template_version (cordis.patch.yml is preserved)" >&2
  fi
fi

tui_link_dir=$profile_dir/node_modules/@dsh-tui
mkdir -p "$tui_link_dir"
for package in dsh-tui providers; do
  tui_link=$tui_link_dir/$package
  if [ -e "$tui_link" ] && [ ! -L "$tui_link" ]; then
    printf '%s\n' "dsh-tui: refusing to replace non-symlink package path $tui_link" >&2
    exit 1
  fi
  ln -sfn "@out@/libexec/dsh/node_modules/@dsh-tui/$package" "$tui_link"
done
exec "@out@/libexec/dsh/bin/dsh" --profile "$profile_name" "$@"
