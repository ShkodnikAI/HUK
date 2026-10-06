#!/usr/bin/env python3
"""HUK — джинглы ИИ-диджея «ВЕКТОР».
espeak-ng (ru) -> радиоеффекты ffmpeg -> микс с музыкальной подложкой из
собственных синтвейв-треков. Результат: upload/radio/jingle_N.mp3
"""
import subprocess
import os
import json

SEED = "/home/z/my-project/upload/radio/seed"
OUT = "/home/z/my-project/upload/radio"
TMP = "/home/z/my-project/scripts/tmp_jingles"
os.makedirs(TMP, exist_ok=True)

JINGLES = [
    "Вы слушаете Хук! Круглосуточное радио с искусственным интеллектом в модерации.",
    "Это Хук. Ваши треки — наша волна.",
    "ИИ диджей Вектор на связи. Загружайте свои треки — лучшие уйдут в эфир.",
    "Хук. Музыка не останавливается. И мы тоже.",
]
BEDS = ["synthwave_neon_rain.mp3", "synthwave_midnight.mp3",
        "synthwave_outrun.mp3", "synthwave_neon_rain.mp3"]
BED_OFFSETS = [12, 20, 16, 24]

def dur(path):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
                                   "format=duration", "-of", "json", path])
    return float(json.loads(out)["format"]["duration"])

for i, text in enumerate(JINGLES):
    raw = f"{TMP}/raw_{i}.wav"
    fx = f"{TMP}/fx_{i}.wav"
    out_mp3 = f"{OUT}/jingle_{i+1}.mp3"

    # 1) Робо-голос ВЕКТОР
    subprocess.run(["espeak-ng", "-v", "ru+female2", "-s", "142", "-p", "38",
                    text, "-w", raw], check=True)

    # 2) Радиообработка: полоса + эхо-студия + компрессия
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-af",
                    "highpass=f=240,lowpass=f=3600,"
                    "aecho=0.8:0.85:28|52:0.28|0.16,"
                    "acompressor=threshold=0.28:ratio=4:attack=8:release=120,"
                    "loudnorm=I=-14:TP=-1.2", fx], check=True)

    # 3) Музыкальная подложка из собственного трека + голос
    vd = dur(fx)
    total = vd + 1.2
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-i", fx,
                    "-ss", str(BED_OFFSETS[i]), "-t", str(total),
                    "-i", f"{SEED}/{BEDS[i]}",
                    "-filter_complex",
                    f"[1:a]volume=0.24,afade=t=in:d=0.4,"
                    f"afade=t=out:st={total-0.9:.2f}:d=0.9[bed];"
                    f"[0:a]adelay=600|600,volume=1.0[vox];"
                    f"[bed][vox]amix=inputs=2:duration=longest:normalize=0,"
                    f"loudnorm=I=-15:TP=-1.3,atrim=0:{total:.2f}",
                    "-codec:a", "libmp3lame", "-b:a", "192k", out_mp3], check=True)
    os.remove(raw); os.remove(fx)
    print(f"jingle_{i+1}.mp3  {dur(out_mp3):.1f}s  «{text[:42]}…»")

print("DONE")
