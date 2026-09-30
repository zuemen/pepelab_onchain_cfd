#!/usr/bin/env bash
# UUPS storage-layout diff: AssetVaultV2_4 (live) -> AssetVaultV2_5 (upgrade).
#
# Passes only if V2_5 is V2_4 with fields APPENDED:
#   1. every V2_4 variable except __gap keeps label, slot, offset and type;
#   2. the new variables sit where V2_4's __gap began (and nowhere else);
#   3. __gap shrinks by exactly the number of slots the new variables use, so
#      the layout still ends on the same slot (nothing a future version or an
#      OZ namespaced parent relies on moves).
#
#   cd contracts && bash script/check-vault-storage-layout.sh [OLD] [NEW]
set -euo pipefail
OLD="${1:-AssetVaultV2_4}"
NEW="${2:-AssetVaultV2_5}"

# Clean first: a stale artifact would compare yesterday's layout.
forge clean
old_json=$(forge inspect "$OLD" storage-layout --json)
new_json=$(forge inspect "$NEW" storage-layout --json)

# label|slot|offset|type (type ids carry the contract name for structs; normalise it)
norm() { jq -r '.storage[] | "\(.label)|\(.slot)|\(.offset)|\(.type)"' | sed -E 's/\(([A-Za-z_]+)\)[0-9]+_storage/(\1)_storage/g; s/AssetVaultV2_[0-9]+\.//g'; }
old_rows=$(echo "$old_json" | norm)
new_rows=$(echo "$new_json" | norm)

echo "== $OLD =="; echo "$old_rows"
echo "== $NEW =="; echo "$new_rows"

fail() { echo "STORAGE LAYOUT CHECK FAILED: $*" >&2; exit 1; }

old_prefix=$(echo "$old_rows" | grep -v '^__gap|')
n_prefix=$(echo "$old_prefix" | wc -l)
new_prefix=$(echo "$new_rows" | head -n "$n_prefix")
[ "$old_prefix" == "$new_prefix" ] || { diff <(echo "$old_prefix") <(echo "$new_prefix") || true; fail "existing fields moved or changed"; }

gap_old_slot=$(echo "$old_json" | jq -r '.storage[] | select(.label=="__gap") | .slot')
gap_new_slot=$(echo "$new_json" | jq -r '.storage[] | select(.label=="__gap") | .slot')
gap_old_type=$(echo "$old_json" | jq -r '.storage[] | select(.label=="__gap") | .type')
gap_new_type=$(echo "$new_json" | jq -r '.storage[] | select(.label=="__gap") | .type')
gap_old_len=$(echo "$gap_old_type" | sed -E 's/.*\)([0-9]+)_storage/\1/')
gap_new_len=$(echo "$gap_new_type" | sed -E 's/.*\)([0-9]+)_storage/\1/')

[ "$(echo "$old_rows" | tail -n1 | cut -d'|' -f1)" == "__gap" ] || fail "$OLD: __gap is not last"
[ "$(echo "$new_rows" | tail -n1 | cut -d'|' -f1)" == "__gap" ] || fail "$NEW: __gap is not last"

appended=$(echo "$new_rows" | sed -n "$((n_prefix + 1)),\$p" | grep -v '^__gap|' || true)
[ -n "$appended" ] || fail "no appended field found"
first_new_slot=$(echo "$appended" | head -n1 | cut -d'|' -f2)
[ "$first_new_slot" == "$gap_old_slot" ] || fail "appended field starts at slot $first_new_slot, expected old __gap slot $gap_old_slot"

used=$((gap_new_slot - gap_old_slot))
[ $((gap_old_len - gap_new_len)) -eq "$used" ] || fail "__gap shrank by $((gap_old_len - gap_new_len)) but new fields use $used slots"
[ $((gap_old_slot + gap_old_len)) -eq $((gap_new_slot + gap_new_len)) ] || fail "layout end slot moved"

echo ""
echo "OK: $NEW = $OLD + appended [$(echo "$appended" | cut -d'|' -f1 | tr '\n' ' ')] at slot $gap_old_slot;"
echo "    __gap $gap_old_len -> $gap_new_len (slot $gap_old_slot -> $gap_new_slot), end slot $((gap_new_slot + gap_new_len)) unchanged."
