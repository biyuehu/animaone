"""GSVI (GPT-SoVITS) TTS 适配器脚本。
供 AnimaOne / chat-ai 外部解耦调用，将文本合成为语音 (.wav)。
"""

import argparse
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# Windows 终端 utf-8 输出容错
if isinstance(sys.stdout, io.TextIOWrapper):
    with contextlib.suppress(AttributeError, OSError):
        sys.stdout.reconfigure(encoding="utf-8")
if isinstance(sys.stderr, io.TextIOWrapper):
    with contextlib.suppress(AttributeError, OSError):
        sys.stderr.reconfigure(encoding="utf-8")

# 本地 GSVI 推理引擎路径（可通过环境变量 GSVI_ROOT 覆盖）
DEFAULT_GSVI_ROOT = Path(r"E:\AI\GSVI推理包 2.4.3 20240414_fix\GPT-SoVITS-Inference")
GSVI_ROOT = Path(os.environ.get("GSVI_ROOT", str(DEFAULT_GSVI_ROOT)))
GSVI_PYTHON = GSVI_ROOT / "runtime" / "python.exe"
GSVI_CLI = GSVI_ROOT / "infer_cli.py"

# AnimaOne 人设 identity -> GSVI 角色映射
IDENTITY_CHAR_MAP: dict[str, str] = {
    "lambda": "Romi",
    "romi": "Romi",
    "sena": "Sena",
}


def check_gsvi_environment() -> None:
    """检查 GSVI 引擎环境与必要文件是否存在。"""
    python_exe = GSVI_PYTHON if GSVI_PYTHON.is_file() else Path(sys.executable)
    if not python_exe.is_file():
        raise FileNotFoundError(f"未找到 Python 解释器: {python_exe}")
    if not GSVI_CLI.is_file():
        raise FileNotFoundError(f"未找到 GSVI 推理脚本: {GSVI_CLI}")


def detect_lang(text: str, specified_lang: str) -> str:
    """语言检测与规整。"""
    specified = (specified_lang or "auto").strip().lower()
    if specified in ("ja", "japanese", "all_ja"):
        return "all_ja"
    if specified in ("zh", "chinese", "all_zh"):
        return "all_zh"
    if specified in ("en", "english", "all_en"):
        return "all_en"

    # auto 模式下：含平假名/片假名转为 all_ja，其余默认中文 all_zh
    has_kana = bool(re.search(r"[\u3040-\u309f\u30a0-\u30ff]", text))
    return "all_ja" if has_kana else "all_zh"


def resolve_character(identity: str, character: str | None) -> str:
    """解析角色名称，优先使用显式指定的 character，其次根据 identity 映射。"""
    if character and character.strip():
        return character.strip()
    ident = (identity or "lambda").strip().lower()
    return IDENTITY_CHAR_MAP.get(ident, "Romi")


def run_gsvi_single(
    text: str,
    output_path: Path,
    character: str = "Romi",
    lang: str = "zh",
    speed: float = 1.0,
) -> None:
    """调用 GSVI 进行单句语音合成。"""
    check_gsvi_environment()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    python_exe = GSVI_PYTHON if GSVI_PYTHON.is_file() else Path(sys.executable)
    resolved_lang = detect_lang(text, lang)

    cmd = [
        str(python_exe),
        str(GSVI_CLI),
        "--character",
        character,
        "--text",
        text,
        "--out",
        str(output_path.resolve()),
        "--lang",
        resolved_lang,
        "--speed",
        str(speed),
    ]

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    result = subprocess.run(
        cmd,
        cwd=str(GSVI_ROOT),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )

    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"GSVI 推理失败 (退出码 {result.returncode})")

    # 转发 stdout 中的成功提示或日志
    for line in result.stdout.splitlines():
        if "SUCCESS:" in line or "加载角色成功" in line:
            print(line)


def run_gsvi_batch(tasks: list[dict[str, Any]]) -> None:
    """批量推理模式。"""
    check_gsvi_environment()
    if not tasks:
        return

    python_exe = GSVI_PYTHON if GSVI_PYTHON.is_file() else Path(sys.executable)

    with tempfile.NamedTemporaryFile(
        "w", suffix=".json", encoding="utf-8", delete=False
    ) as tf:
        json.dump(tasks, tf, ensure_ascii=False, indent=2)
        tmp_json = tf.name

    try:
        cmd = [
            str(python_exe),
            str(GSVI_CLI),
            "--batch-file",
            tmp_json,
        ]
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run(
            cmd,
            cwd=str(GSVI_ROOT),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode != 0:
            print(result.stderr, file=sys.stderr)
            raise RuntimeError(f"GSVI 批量推理失败 (退出码 {result.returncode})")
        print(result.stdout)
    finally:
        if os.path.exists(tmp_json):
            with contextlib.suppress(OSError):
                os.remove(tmp_json)


def main() -> None:
    parser = argparse.ArgumentParser(description="AnimaOne GSVI TTS 适配器")
    parser.add_argument("--text", "-t", required=True, help="需要合成的文本")
    parser.add_argument("--out", "-o", required=True, help="输出音频路径 (.wav)")
    parser.add_argument(
        "--identity",
        "-i",
        default="lambda",
        help="AnimaOne 身份标识 (lambda, sena, etc.)",
    )
    parser.add_argument(
        "--character",
        "-c",
        default="",
        help="覆盖指定的 GSVI 角色名 (Romi / Sena / Hutao)",
    )
    parser.add_argument(
        "--lang", "-l", default="auto", help="语言 (zh / ja / en / auto)"
    )
    parser.add_argument("--speed", "-s", type=float, default=1.0, help="合成语速")

    args = parser.parse_args()

    character = resolve_character(args.identity, args.character)
    output_path = Path(args.out)

    run_gsvi_single(
        text=args.text,
        output_path=output_path,
        character=character,
        lang=args.lang,
        speed=args.speed,
    )


if __name__ == "__main__":
    main()
