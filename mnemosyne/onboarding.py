"""Additive-only Qdrant collection creation + scope-mapping registration.

Story: ro-06-collection-creation-and-scope-mapping
Epic:  mnemosyne-repo-onboarding

Research spike findings (this story's own first, blocking step -- recorded
here per its acceptance criterion #1, never left as an assumption):

1. Does swarm-memory expose a collection-create CLI verb?

   No. The real, installed ``swarm-memory`` CLI (pipx venv at
   ``~/.local/pipx/venvs/swarm-memory``; confirmed by running the actual
   binary, not by reading the sibling repo's source, which is not checked
   out on this machine at the path the story guessed --
   ``~/Documents/work/dostal/code/swarm-memory`` does not exist here; the
   real, currently-installed swarm-memory package is the actual dependency
   ``VectorLayerAdapter.ts`` shells out to, so it is the authoritative
   source, not a stale guessed path) has these subcommands, confirmed via
   ``swarm-memory --help``::

       recall, search, grep, check, scopes, index, graph, config,
       install-hermes

   None of these is a dedicated "create a collection" verb. The only way
   the CLI ever creates a collection is as an internal SIDE EFFECT of
   ``swarm-memory index <collection> <paths>`` -- its ``indexer.py``'s
   ``index_paths()`` calls the package's own internal
   ``QdrantClient.ensure_collection(collection, dim)`` (``swarm_memory/
   qdrant.py``) before upserting any chunks. Driving that path to create an
   (initially empty) collection would require real file paths to index and
   a reachable embedder (ollama/openai) -- a heavier, less direct, and
   less safe primitive than "create an empty collection," and not a clean
   creation-only building block this module can call in isolation.

   DECISION: no clean swarm-memory-native creation path exists. This
   module takes the fallback path the story named explicitly: extend this
   package's own ``HttpQdrantClient``
   (``mnemosyne/inventory/qdrant_inventory.py``, read-only until this
   story) with a narrow, additive-only ``create_collection()`` method that
   calls Qdrant's own ``PUT /collections/{name}`` directly -- mirroring
   the exact request shape swarm-memory's own internal
   ``ensure_collection()`` already uses (``{"vectors": {"size": dim,
   "distance": "Cosine"}}``), so a collection this module creates is
   layout-compatible with one swarm-memory's own indexer would have
   created.

2. Where does the real scope -> collection map live on disk?

   ``~/.config/swarm-memory/config.toml``'s ``[scopes]`` TOML table --
   confirmed directly from the installed package's own source:
   ``swarm_memory/config.py``'s ``load_config()`` reads
   ``data.get("scopes", {})`` from exactly that file (default path,
   overridable via ``$SWARM_MEMORY_CONFIG``), and ``swarm_memory/cli.py``'s
   ``cmd_config()`` prints ``cfg.scopes`` verbatim as part of its JSON
   output. That JSON output is exactly what ``VectorLayerAdapter.ts``
   parses at its ``cfg.scopes?.[scope]`` read site
   (``VectorLayerAdapter.ts:213-226``, via ``swarm-memory config`` with no
   flags -- the command already prints JSON unconditionally, confirmed
   from ``cmd_config``'s source). This is the SAME file
   ``mnemosyne/inventory/qdrant_inventory.py``'s own ``DEFAULT_CONFIG_PATH``
   already points at for its ``[qdrant] url`` read -- this module reuses
   that exact constant and writes to the same file, a different table.

Additive-only, by design: no delete/drop code path exists anywhere in this
module, or in the ``HttpQdrantClient.create_collection()`` method it calls
into -- ways_of_working.md's hard "never wipe Qdrant" rule. A conflicting
scope mapping (already pointing at a *different* collection) is refused
loudly rather than silently overwritten, for the same reason.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mnemosyne.inventory.qdrant_inventory import DEFAULT_CONFIG_PATH, list_collection_names

# Matches swarm-memory's own default embedder dim (nomic-embed-text,
# ~/.config/swarm-memory/config.toml's [embedder] section on this machine).
# A caller onboarding against a differently-configured swarm-memory install
# should pass the real dim explicitly (e.g. read from `swarm-memory
# config`'s own `embedder.dim` field) rather than rely on this default.
DEFAULT_DIM = 768

_SCOPES_HEADER_RE = re.compile(r"^\[scopes\]\s*$")
_SAFE_BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class OnboardingError(RuntimeError):
    """Raised only for invalid-input / programmer-error cases (empty or
    unsafe names). Real infra-level failures and partial-failure states are
    never raised -- they are reported via CollectionCreationResult.ok /
    .detail, per this story's own loud-failure cross-cutting requirement
    (a retry or manual fix must be possible without re-deriving what
    happened)."""


@dataclass(frozen=True)
class CollectionCreationResult:
    """Outcome of create_collection_and_scope() -- always returned, never
    raised for an infra-level partial failure, so which half succeeded is
    always inspectable programmatically, not just from a log line."""

    name: str
    scope: str
    collection_created: bool
    scope_mapped: bool
    ok: bool
    detail: str


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _read_scopes_from_toml(text: str) -> dict[str, str]:
    """Minimal, read-only [scopes]-table reader. No TOML-writer dependency
    is added by this story -- the installed swarm-memory package itself
    only ever READS its config.toml via stdlib ``tomllib`` (see
    swarm_memory/config.py); this module mirrors that same
    read-with-stdlib-only discipline for the small additive write it makes
    (see ``_insert_scope_line`` below)."""
    scopes: dict[str, str] = {}
    in_scopes = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_scopes = bool(_SCOPES_HEADER_RE.match(stripped))
            continue
        if not in_scopes or not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            continue
        key, _, raw_value = stripped.partition("=")
        scopes[key.strip()] = raw_value.strip().strip('"').strip("'")
    return scopes


def _insert_scope_line(text: str, scope: str, collection: str) -> str:
    """Add exactly one new ``scope = "collection"`` line to the [scopes]
    table -- additive-only, never rewrites, reorders, or removes any
    existing line. Creates a new [scopes] table at file end when none
    exists yet."""
    new_line = f'{scope} = "{_toml_escape(collection)}"'
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if _SCOPES_HEADER_RE.match(line.strip()):
            lines.insert(i + 1, new_line)
            return "\n".join(lines) + "\n"
    suffix = "" if text == "" or text.endswith("\n") else "\n"
    return f"{text}{suffix}\n[scopes]\n{new_line}\n"


def write_scope_mapping(
    scope: str,
    collection: str,
    config_path: str | Path = DEFAULT_CONFIG_PATH,
) -> bool:
    """Idempotently write ``scope -> collection`` into swarm-memory's real
    ``config.toml`` ``[scopes]`` table -- the exact file/table
    ``VectorLayerAdapter.remember()`` reads via ``swarm-memory config``
    (``VectorLayerAdapter.ts:213-226``; see this module's own docstring for
    the research trail confirming this location).

    Returns True if a new mapping was written, False if ``scope`` already
    mapped to ``collection`` (idempotent no-op -- detected via a read-only
    parse of the existing file, never a blind write). Raises
    OnboardingError if ``scope`` is already mapped to a DIFFERENT
    collection (a real conflict, never silently overwritten) or if
    ``scope``/``collection`` contain characters unsafe for a bare TOML key
    / basic string.
    """
    if not _SAFE_BARE_KEY_RE.match(scope):
        raise OnboardingError(
            f"scope {scope!r} is not a safe bare TOML key (letters, digits, '_', '-' only)"
        )
    if not collection:
        raise OnboardingError("collection name must not be empty")

    path = Path(config_path).expanduser()
    text = path.read_text(encoding="utf-8") if path.is_file() else ""

    existing = _read_scopes_from_toml(text)
    if scope in existing:
        if existing[scope] == collection:
            return False
        raise OnboardingError(
            f"scope {scope!r} is already mapped to collection {existing[scope]!r}, "
            f"not {collection!r} -- refusing to silently overwrite an existing scope mapping"
        )

    updated = _insert_scope_line(text, scope, collection)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf-8")
    return True


def create_collection_and_scope(
    name: str,
    scope: str,
    *,
    client: Any,
    dim: int = DEFAULT_DIM,
    config_path: str | Path = DEFAULT_CONFIG_PATH,
) -> CollectionCreationResult:
    """Additive-only: create Qdrant collection ``name`` (if it doesn't
    already exist) and register ``scope -> name`` in swarm-memory's real
    ``config.toml`` ``[scopes]`` table (if not already mapped) -- the exact
    write ``VectorLayerAdapter.remember()`` needs before it will accept
    writes for ``scope`` instead of failing with ``unknown_scope``
    (``VectorLayerAdapter.ts:213-226``).

    ``client`` must implement ``list_collections() -> list[str]`` and
    ``create_collection(name: str, dim: int) -> None`` -- the same shape
    ``mnemosyne.inventory.qdrant_inventory.HttpQdrantClient`` now
    implements. Callers wire in a real client for production use (e.g.
    ``HttpQdrantClient(url, api_key)``) and a mockable fake for tests --
    this function never constructs a client itself and never makes a live
    Qdrant call in the unit test suite.

    Idempotent: safe to call twice with the same ``(name, scope)`` -- the
    second call detects both halves already done via read-only checks
    (Qdrant's own collection list; config.toml's own [scopes] table) and
    returns ``ok=True`` with both flags False, never a duplicate collection
    and never a duplicate/blind write.

    No delete/drop code path exists anywhere in this module or in
    ``HttpQdrantClient`` -- ways_of_working.md's hard "never wipe Qdrant"
    rule.

    Never raises for a partial-failure infra state (e.g. the collection is
    created but the scope-mapping write then fails) -- always returns a
    ``CollectionCreationResult`` whose ``.detail`` states exactly which
    half succeeded, so a retry or manual fix is possible without
    re-deriving what happened.
    """
    if not name or not name.strip():
        raise OnboardingError("collection name must not be empty")
    if not scope or not scope.strip():
        raise OnboardingError("scope must not be empty")

    try:
        existing_collections = list_collection_names(client)
    except Exception as exc:
        return CollectionCreationResult(
            name=name,
            scope=scope,
            collection_created=False,
            scope_mapped=False,
            ok=False,
            detail=f"could not list existing collections; nothing was attempted: {exc}",
        )

    collection_created = False
    if name not in existing_collections:
        try:
            client.create_collection(name, dim)
            collection_created = True
        except Exception as exc:
            return CollectionCreationResult(
                name=name,
                scope=scope,
                collection_created=False,
                scope_mapped=False,
                ok=False,
                detail=f"collection creation failed; no scope-mapping write was attempted: {exc}",
            )

    collection_state = "created" if collection_created else "already existed"
    try:
        scope_mapped = write_scope_mapping(scope, name, config_path)
    except (OnboardingError, OSError) as exc:
        return CollectionCreationResult(
            name=name,
            scope=scope,
            collection_created=collection_created,
            scope_mapped=False,
            ok=False,
            detail=(
                f"collection {name!r} {collection_state} successfully, "
                f"but the scope-mapping write for scope {scope!r} failed: {exc}"
            ),
        )

    return CollectionCreationResult(
        name=name,
        scope=scope,
        collection_created=collection_created,
        scope_mapped=scope_mapped,
        ok=True,
        detail=(
            f"collection {name!r} {collection_state}; "
            f"scope {scope!r} mapping "
            f"{'written' if scope_mapped else 'already present'}"
        ),
    )
