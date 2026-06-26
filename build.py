# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "cryptography",
#     "pyyaml",
#     "pillow",
# ]
# ///

"""
Build script for Encrypted Photo Gallery.
Reads feed.yaml and raw photos in photos/, compresses images into dual-tier sizes
(<= 200KB thumb, <= 2MB full), encrypts all assets with AES-GCM (256-bit), and
outputs data.js and encrypted_photos/*.json.
"""

import os
import io
import json
import yaml
import glob
import base64
import shutil
from PIL import Image
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PHOTOS_DIR = os.path.join(SCRIPT_DIR, "photos")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "encrypted_photos")
DATA_JS_FILE = os.path.join(SCRIPT_DIR, "data.js")
FEED_YAML_FILE = os.path.join(SCRIPT_DIR, "feed.yaml")
PASSWORD_FILE = os.path.join(SCRIPT_DIR, "PASSWORD")


def compress_image_to_limit(img, max_bytes, max_dim):
    """Compresses a PIL Image as JPEG to stay strictly under max_bytes."""
    w, h = img.size
    scale = 1.0
    if max(w, h) > max_dim:
        scale = max_dim / float(max(w, h))

    curr_img = img
    if scale < 1.0:
        new_w = int(w * scale)
        new_h = int(h * scale)
        curr_img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

    quality = 85
    while True:
        buf = io.BytesIO()
        curr_img.save(buf, format="JPEG", quality=quality, optimize=True)
        size = len(buf.getvalue())
        if size <= max_bytes or (quality <= 20 and curr_img.size[0] <= 400):
            return buf.getvalue()
        
        if quality > 40:
            quality -= 15
        else:
            # Further downscale if quality reduction isn't enough
            new_w = int(curr_img.size[0] * 0.8)
            new_h = int(curr_img.size[1] * 0.8)
            curr_img = curr_img.resize((new_w, new_h), Image.Resampling.LANCZOS)


def derive_key(password, salt):
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
    )
    return kdf.derive(password.encode("utf-8"))


def encrypt_payload(key, data_bytes):
    aesgcm = AESGCM(key)
    iv = os.urandom(12)
    ciphertext = aesgcm.encrypt(iv, data_bytes, None)
    return {
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(ciphertext).decode("utf-8")
    }


def main():
    print("🚀 Starting Encrypted Photo Gallery build...")

    if not os.path.exists(FEED_YAML_FILE):
        print(f"❌ Error: {FEED_YAML_FILE} not found.")
        return

    password = None
    if os.path.exists(PASSWORD_FILE):
        with open(PASSWORD_FILE, "r", encoding="utf-8") as pf:
            password = pf.read().strip()

    if not password:
        print("⚠️ No password found in PASSWORD file. Building in PLAINTEXT mode.")
        salt = None
        key = None
    else:
        print("🔒 Password found. Deriving 256-bit AES key...")
        salt = os.urandom(16)
        key = derive_key(password, salt)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    # Clean old encrypted photos
    for old_file in glob.glob(os.path.join(OUTPUT_DIR, "*.json")):
        os.remove(old_file)

    with open(FEED_YAML_FILE, "r", encoding="utf-8") as yf:
        feed_config = yaml.safe_load(yf) or {}

    raw_feed = feed_config.get("feed", [])
    processed_feed = []
    photo_count = 0

    for idx, item in enumerate(raw_feed):
        item_type = item.get("type")
        if item_type in ["heading", "narrative"]:
            processed_feed.append({
                "type": item_type,
                "text": item.get("text", "").strip(),
                "subtitle": item.get("subtitle", "").strip()
            })
        elif item_type == "photo":
            photo_count += 1
            photo_id = f"photo_{photo_count:03d}"
            filename = item.get("file", "")
            raw_path = os.path.join(PHOTOS_DIR, filename)

            if not os.path.exists(raw_path):
                print(f"⚠️ Warning: Photo file not found: {raw_path}. Skipping.")
                continue

            print(f"  🖼️ Processing {filename} ({photo_id})...")
            with Image.open(raw_path) as img:
                img_rgb = img.convert("RGB")
                # Compress thumbnail <= 200KB (max dim 1000px)
                thumb_bytes = compress_image_to_limit(img_rgb, 200 * 1024, max_dim=1000)
                # Compress full <= 2MB (max dim 3000px)
                full_bytes = compress_image_to_limit(img_rgb, 2 * 1024 * 1024, max_dim=3000)

            print(f"     Thumb: {len(thumb_bytes)/1024:.1f} KB | Full: {len(full_bytes)/1024:.1f} KB")

            if key:
                thumb_payload = encrypt_payload(key, thumb_bytes)
                full_payload = encrypt_payload(key, full_bytes)
            else:
                thumb_payload = {"plaintext_b64": base64.b64encode(thumb_bytes).decode("utf-8")}
                full_payload = {"plaintext_b64": base64.b64encode(full_bytes).decode("utf-8")}

            thumb_payload["mime"] = "image/jpeg"
            full_payload["mime"] = "image/jpeg"

            with open(os.path.join(OUTPUT_DIR, f"{photo_id}_thumb.json"), "w", encoding="utf-8") as tf:
                json.dump(thumb_payload, tf)
            with open(os.path.join(OUTPUT_DIR, f"{photo_id}_full.json"), "w", encoding="utf-8") as ff:
                json.dump(full_payload, ff)

            processed_feed.append({
                "type": "photo",
                "id": photo_id,
                "caption": item.get("caption", "").strip(),
                "alt": item.get("alt", "").strip()
            })
        else:
            print(f"❓ Unknown item type: {item_type}")

    gallery_manifest = {
        "title": feed_config.get("title", "Encrypted Photo Gallery"),
        "description": feed_config.get("description", ""),
        "feed": processed_feed
    }

    manifest_json = json.dumps(gallery_manifest, ensure_ascii=False)

    if key:
        encrypted_manifest = encrypt_payload(key, manifest_json.encode("utf-8"))
        output_data = {
            "encrypted": True,
            "salt": base64.b64encode(salt).decode("utf-8"),
            "iv": encrypted_manifest["iv"],
            "ciphertext": encrypted_manifest["ciphertext"]
        }
    else:
        output_data = {
            "encrypted": False,
            "manifest": gallery_manifest
        }

    with open(DATA_JS_FILE, "w", encoding="utf-8") as df:
        df.write("// Auto-generated by build.py — do not edit manually\n")
        df.write("const GALLERY_DATA = ")
        json.dump(output_data, df, indent=2, ensure_ascii=False)
        df.write(";\n")

    print(f"\n✅ Build complete! Processed {photo_count} photos and {len(processed_feed)} feed items.")
    print(f"📁 Encrypted assets written to {OUTPUT_DIR}/ and data.js.")


if __name__ == "__main__":
    main()
