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
import hashlib
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


def process_photo_asset(filename, asset_id, key):
    raw_path = os.path.join(PHOTOS_DIR, filename)
    if not os.path.exists(raw_path):
        print(f"⚠️ Warning: Photo file not found: {raw_path}. Skipping.")
        return False

    print(f"  🖼️ Processing {filename} ({asset_id})...")
    with Image.open(raw_path) as img:
        img_rgb = img.convert("RGB")
        thumb_bytes = compress_image_to_limit(img_rgb, 200 * 1024, max_dim=1000)
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

    with open(os.path.join(OUTPUT_DIR, f"{asset_id}_thumb.json"), "w", encoding="utf-8") as tf:
        json.dump(thumb_payload, tf)
    with open(os.path.join(OUTPUT_DIR, f"{asset_id}_full.json"), "w", encoding="utf-8") as ff:
        json.dump(full_payload, ff)

    return True


def main():
    print("🚀 Starting Encrypted Photo Gallery build...")

    if not os.path.exists(FEED_YAML_FILE):
        print(f"❌ Error: {FEED_YAML_FILE} not found.")
        return

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for old_file in glob.glob(os.path.join(OUTPUT_DIR, "*.json")):
        os.remove(old_file)

    with open(FEED_YAML_FILE, "r", encoding="utf-8") as yf:
        feed_config = yaml.safe_load(yf) or {}

    showcase_meta = {
        "title": "Antigravity Secure Vault",
        "description": "Zero-Knowledge Encrypted Sharing"
    }

    albums_map = {}
    total_photos = 0

    root_index_path = os.path.join(SCRIPT_DIR, "index.html")
    root_index_html = ""
    if os.path.exists(root_index_path):
        with open(root_index_path, "r", encoding="utf-8") as rf:
            root_index_html = rf.read()

    raw_albums = feed_config.get("albums", [])
    for album_entry in raw_albums:
        a_file = album_entry.get("file", "").strip() if isinstance(album_entry, dict) else str(album_entry).strip()
        album_yaml_path = os.path.join(SCRIPT_DIR, a_file)
        if not os.path.exists(album_yaml_path):
            print(f"⚠️ Warning: Album file {a_file} not found. Skipping.")
            continue

        with open(album_yaml_path, "r", encoding="utf-8") as af:
            a_data = yaml.safe_load(af) or {}

        slug = a_data.get("url", "").strip()
        if not slug:
            slug = a_file.replace("-feed.yaml", "").replace(".yaml", "")
        slug = slug.lstrip("/")

        slug_hash = hashlib.sha256(slug.encode("utf-8")).hexdigest()
        short_id = slug_hash[:16]

        pwd = a_data.get("password", "").strip()
        a_title = a_data.get("title", slug).strip()
        a_desc = a_data.get("description", "").strip()

        print(f"\n📂 Processing Album: {a_title} (URL hash: #{slug})...")

        if not pwd:
            print(f"⚠️ No password specified for {slug}. Storing in PLAINTEXT mode.")
            salt = None
            key = None
        else:
            print(f"🔒 Password found for #{slug}. Deriving 256-bit AES key...")
            salt = os.urandom(16)
            key = derive_key(pwd, salt)

        raw_feed = a_data.get("feed", [])
        processed_feed = []
        photo_count = 0

        for item in raw_feed:
            item_type = item.get("type")
            if item_type in ["heading", "narrative"]:
                processed_feed.append({
                    "type": item_type,
                    "text": item.get("text", "").strip(),
                    "subtitle": item.get("subtitle", "").strip()
                })
            elif item_type == "photo":
                photo_count += 1
                total_photos += 1
                photo_id = f"{short_id}_photo_{photo_count:03d}"
                filename = item.get("file", "")
                if process_photo_asset(filename, photo_id, key):
                    processed_feed.append({
                        "type": "photo",
                        "id": photo_id,
                        "caption": item.get("caption", "").strip(),
                        "alt": item.get("alt", "").strip()
                    })
            else:
                print(f"❓ Unknown item type: {item_type}")

        album_manifest = {
            "title": a_title,
            "description": a_desc,
            "feed": processed_feed
        }

        if key:
            encrypted_manifest = encrypt_payload(key, json.dumps(album_manifest, ensure_ascii=False).encode("utf-8"))
            albums_map[slug_hash] = {
                "encrypted": True,
                "salt": base64.b64encode(salt).decode("utf-8"),
                "iv": encrypted_manifest["iv"],
                "ciphertext": encrypted_manifest["ciphertext"]
            }
        else:
            albums_map[slug_hash] = {
                "encrypted": False,
                "manifest": album_manifest
            }

    output_data = {
        "showcase": showcase_meta,
        "albums": albums_map
    }

    with open(DATA_JS_FILE, "w", encoding="utf-8") as df:
        df.write("// Auto-generated by build.py — do not edit manually\n")
        df.write("const GALLERY_DATA = ")
        json.dump(output_data, df, indent=2, ensure_ascii=False)
        df.write(";\n")

    print(f"\n✅ Build complete! Processed {len(albums_map)} albums and {total_photos} photos.")
    print(f"📁 Encrypted assets written to {OUTPUT_DIR}/ and data.js.")


if __name__ == "__main__":
    main()
