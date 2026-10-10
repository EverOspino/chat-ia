from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "assets" / "avatars"
BLOCKED = (
    "loli",
    "shota",
    "colegial",
    "school",
    "escolar",
    "klee",
    "soukaku",
    "miku",
    "haruhi",
    "blue archive",
    "ralts",
    "niña",
    "nena",
    "menor",
    "child",
    "underage",
)


def allowed(name: str) -> bool:
    low = (name or "").lower()
    if not low.endswith(".vrm"):
        return False
    if "/" in name or "\\" in name or name.startswith("."):
        return False
    return not any(word in low for word in BLOCKED)


def list_models() -> list[str]:
    if not ROOT.is_dir():
        return []
    names = [path.name for path in ROOT.iterdir() if path.is_file() and allowed(path.name)]
    return sorted(names, key=str.lower)


def resolve_model(name: str) -> Path | None:
    if not allowed(name):
        return None
    path = (ROOT / Path(name).name).resolve()
    if not str(path).startswith(str(ROOT.resolve())):
        return None
    if not path.is_file():
        return None
    return path


def default_model() -> str:
    names = list_models()
    if "atlas.vrm" in names:
        return "atlas.vrm"
    return names[0] if names else ""
