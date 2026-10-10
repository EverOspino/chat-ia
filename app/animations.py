from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "assets" / "animations"


def allowed(name: str) -> bool:
    low = (name or "").lower()
    if not low.endswith(".fbx"):
        return False
    if "/" in name or "\\" in name or name.startswith("."):
        return False
    return True


def list_clips() -> list[str]:
    if not ROOT.is_dir():
        return []
    names = [path.name for path in ROOT.iterdir() if path.is_file() and allowed(path.name)]
    return sorted(names, key=str.lower)


def resolve_clip(name: str) -> Path | None:
    if not allowed(name):
        return None
    path = (ROOT / Path(name).name).resolve()
    if not str(path).startswith(str(ROOT.resolve())):
        return None
    if not path.is_file():
        return None
    return path
