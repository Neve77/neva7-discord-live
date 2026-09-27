"""Gera amostras e mede latência local; não inicia o bot nem envia áudio ao Discord."""
import argparse
import json
import os
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "tools" / "chatterbox"
os.environ.setdefault("HF_HOME", str(ASSETS / "cache" / "huggingface"))
os.environ.setdefault("TORCH_HOME", str(ASSETS / "cache" / "torch"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("PYTHONUTF8", "1")
sys.path.insert(0, str(ASSETS / "source" / "chatterbox" / "src"))

DEFAULT_TEXT = "E aí, beleza? Você tá me ouvindo direitinho? Tô aqui no Discord. Bora entrar na call e jogar mais uma partida?"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--reference", type=Path, default=ASSETS / "reference-pt-br.wav")
    args = parser.parse_args()
    if not args.text.strip() or len(args.text) > 300:
        parser.error("Use uma frase com 1 a 300 caracteres.")
    if not args.reference.is_file():
        parser.error("Referência não encontrada. Execute npm run setup:chatterbox.")

    print("Carregando bibliotecas...", flush=True)
    import numpy as np
    import soundfile as sf
    import torch
    from chatterbox.tts import ChatterboxTTS

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA indisponível; confira a instalação do PyTorch e o driver NVIDIA.")
    torch.set_num_threads(8)
    output = ROOT / "samples" / "chatterbox"
    output.mkdir(parents=True, exist_ok=True)
    print(f"GPU: {torch.cuda.get_device_name(0)}", flush=True)
    start = time.perf_counter()
    model = ChatterboxTTS.from_local(ASSETS / "models", device="cuda")
    torch.cuda.synchronize()
    load_seconds = time.perf_counter() - start
    print(f"Modelo carregado em {load_seconds:.2f}s. Preparando a referência brasileira...", flush=True)
    start = time.perf_counter()
    model.prepare_conditionals(str(args.reference), exaggeration=0.5)
    torch.cuda.synchronize()
    reference_seconds = time.perf_counter() - start
    report = {
        "model": "ResembleAI/Chatterbox-Multilingual-pt-br",
        "gpu": torch.cuda.get_device_name(0), "torch": torch.__version__,
        "load_seconds": round(load_seconds, 3), "reference_seconds": round(reference_seconds, 3),
        "reference": str(args.reference), "text": args.text, "samples": [],
    }
    profiles = [("01-primeira", 0.5, 0.5, 0.8), ("02-natural", 0.5, 0.5, 0.8), ("03-conversa", 0.35, 0.3, 0.75)]
    for name, exaggeration, cfg, temperature in profiles:
        random.seed(42)
        np.random.seed(42)
        torch.manual_seed(42)
        torch.cuda.manual_seed_all(42)
        torch.cuda.reset_peak_memory_stats()
        start = time.perf_counter()
        print(f"Gerando {name}...", flush=True)
        with torch.inference_mode():
            audio = model.generate(args.text, language_id="pt", exaggeration=exaggeration, cfg_weight=cfg, temperature=temperature)
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - start
        samples = audio.squeeze(0).cpu().numpy()
        duration = len(samples) / model.sr
        if not np.isfinite(samples).all() or duration < 0.2 or np.max(np.abs(samples)) < 0.0001:
            raise RuntimeError(f"Áudio inválido em {name}.")
        dest = output / f"{name}.wav"
        sf.write(dest, samples, model.sr, subtype="PCM_16")
        entry = {"file": dest.name, "generation_seconds": round(elapsed, 3), "audio_seconds": round(duration, 3),
                 "rtf": round(elapsed / duration, 3), "peak_vram_mb": round(torch.cuda.max_memory_allocated() / 1024**2),
                 "exaggeration": exaggeration, "cfg_weight": cfg, "temperature": temperature}
        report["samples"].append(entry)
        (output / "resultados.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"OK: {dest.name} | geração {elapsed:.2f}s | áudio {duration:.2f}s | VRAM {entry['peak_vram_mb']} MB", flush=True)
    print(f"Amostras e medições: {output}", flush=True)


if __name__ == "__main__":
    main()
