/**
 * Client-side App Logic & Decryption Engine for Secure Photo Gallery
 */

class PhotoGalleryApp {
  constructor() {
    this.rawManifest = typeof GALLERY_DATA !== 'undefined' ? GALLERY_DATA : null;
    this.key = null;
    this.manifest = null;
    this.blobCache = new Map(); // id_size -> blobURL
    this.currentIndex = 0;
    this.lightboxItems = []; // clickable items in sequential order
    
    // Swipe state
    this.touchStartX = 0;
    this.touchEndX = 0;

    this.init();
  }

  base64ToArrayBuffer(base64) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async init() {
    this.bindEvents();

    if (!this.rawManifest) {
      document.getElementById('galleryDescription').textContent = "Error: GALLERY_DATA not found.";
      return;
    }

    if (!this.rawManifest.encrypted) {
      // Plaintext mode
      this.manifest = this.rawManifest.manifest;
      document.getElementById('authOverlay').classList.add('hidden');
      this.renderFeed();
      return;
    }

    // Try auto-unlocking from sessionStorage
    const savedPwd = sessionStorage.getItem('gallery_pwd');
    if (savedPwd) {
      const success = await this.unlock(savedPwd, true);
      if (success) return;
    }
  }

  bindEvents() {
    const authForm = document.getElementById('authForm');
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwd = document.getElementById('passwordInput').value;
      await this.unlock(pwd, false);
    });

    document.getElementById('lockBtn').addEventListener('click', () => {
      sessionStorage.removeItem('gallery_pwd');
      window.location.reload();
    });

    // Lightbox events
    document.getElementById('lightboxClose').addEventListener('click', () => this.closeLightbox());
    document.getElementById('lightboxPrev').addEventListener('click', () => this.navigateLightbox(-1));
    document.getElementById('lightboxNext').addEventListener('click', () => this.navigateLightbox(1));

    document.addEventListener('keydown', (e) => {
      const lb = document.getElementById('lightbox');
      if (!lb.classList.contains('active')) return;
      if (e.key === 'Escape') this.closeLightbox();
      if (e.key === 'ArrowLeft') this.navigateLightbox(-1);
      if (e.key === 'ArrowRight') this.navigateLightbox(1);
    });

    // Touch swipe for Lightbox
    const stage = document.getElementById('lightboxStage');
    stage.addEventListener('touchstart', (e) => {
      this.touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    stage.addEventListener('touchend', (e) => {
      this.touchEndX = e.changedTouches[0].screenX;
      this.handleSwipe();
    }, { passive: true });
  }

  handleSwipe() {
    const threshold = 50;
    const diff = this.touchStartX - this.touchEndX;
    if (Math.abs(diff) > threshold) {
      if (diff > 0) {
        this.navigateLightbox(1); // Swipe left -> next
      } else {
        this.navigateLightbox(-1); // Swipe right -> prev
      }
    }
  }

  async unlock(password, isSilent = false) {
    const errEl = document.getElementById('authError');
    errEl.style.display = 'none';

    try {
      const salt = this.base64ToArrayBuffer(this.rawManifest.salt);
      const iv = this.base64ToArrayBuffer(this.rawManifest.iv);
      const ciphertext = this.base64ToArrayBuffer(this.rawManifest.ciphertext);

      const enc = new TextEncoder();
      const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
      );

      this.key = await window.crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: salt,
          iterations: 100000,
          hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
      );

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        this.key,
        ciphertext
      );

      const dec = new TextDecoder();
      this.manifest = JSON.parse(dec.decode(decryptedBuffer));

      sessionStorage.setItem('gallery_pwd', password);
      document.getElementById('authOverlay').classList.add('hidden');
      this.renderFeed();
      return true;

    } catch (e) {
      if (!isSilent) {
        errEl.style.display = 'block';
        const input = document.getElementById('passwordInput');
        input.value = '';
        input.focus();
      }
      return false;
    }
  }

  async decryptAsset(payload) {
    if (payload.plaintext_b64) {
      const buf = this.base64ToArrayBuffer(payload.plaintext_b64);
      return new Blob([buf], { type: payload.mime || 'image/jpeg' });
    }

    const iv = this.base64ToArrayBuffer(payload.iv);
    const ciphertext = this.base64ToArrayBuffer(payload.ciphertext);

    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      this.key,
      ciphertext
    );

    return new Blob([decrypted], { type: payload.mime || 'image/jpeg' });
  }

  async getAssetBlobUrl(id, tier) {
    const cacheKey = `${id}_${tier}`;
    if (this.blobCache.has(cacheKey)) {
      return this.blobCache.get(cacheKey);
    }

    try {
      const resp = await fetch(`encrypted_photos/${id}_${tier}.json`);
      if (!resp.ok) return null;
      const payload = await resp.json();
      const blob = await this.decryptAsset(payload);
      const url = URL.createObjectURL(blob);
      this.blobCache.set(cacheKey, url);
      return url;
    } catch (err) {
      console.error(`Failed to load asset ${id}_${tier}:`, err);
      return null;
    }
  }

  renderFeed() {
    document.getElementById('galleryTitle').textContent = this.manifest.title;
    document.getElementById('galleryDescription').textContent = this.manifest.description || 'Secure Collection';

    const container = document.getElementById('feedContainer');
    container.innerHTML = '';
    this.lightboxItems = [];

    this.manifest.feed.forEach((item, idx) => {
      const lbIdx = this.lightboxItems.length;
      this.lightboxItems.push(item);

      if (item.type === 'heading') {
        const hEl = document.createElement('div');
        hEl.className = 'feed-heading';
        hEl.style.cursor = 'pointer';
        hEl.innerHTML = `<h2>${item.text}</h2>${item.subtitle ? `<span>${item.subtitle}</span>` : ''}`;
        hEl.addEventListener('click', () => this.openLightbox(lbIdx));
        container.appendChild(hEl);
      } else if (item.type === 'narrative') {
        const nEl = document.createElement('div');
        nEl.className = 'feed-narrative';
        let html = '';
        if (item.text) html += `<h3>${item.text.replace(/\n/g, '<br>')}</h3>`;
        if (item.subtitle) html += `<p>${item.subtitle.replace(/\n/g, '<br>')}</p>`;
        nEl.innerHTML = html;
        nEl.addEventListener('click', () => this.openLightbox(lbIdx));
        container.appendChild(nEl);
      } else if (item.type === 'photo') {
        const card = document.createElement('div');
        card.className = 'feed-photo-card';
        card.innerHTML = `
          <div class="photo-thumb-wrapper">
            <div class="skeleton-shimmer" id="shimmer_${item.id}"></div>
            <img class="photo-thumb" id="thumb_${item.id}" alt="${item.alt || ''}">
          </div>
          ${item.caption ? `<div class="photo-caption">${item.caption}</div>` : ''}
        `;
        card.addEventListener('click', () => this.openLightbox(lbIdx));
        container.appendChild(card);
      }
    });

    // Add synthetic end card for full-screen mode
    this.lightboxItems.push({
      type: 'end',
      text: "End of Collection",
      subtitle: "Swipe right or press arrow key once more to exit full-screen view"
    });

    // Setup background lazy loading for thumbnails
    this.setupThumbLoading();
  }

  setupThumbLoading() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const photoId = img.dataset.id;
          observer.unobserve(img);
          this.loadThumbnail(photoId);
        }
      });
    }, { rootMargin: '300px 0px' });

    this.manifest.feed.forEach(item => {
      if (item.type === 'photo') {
        const img = document.getElementById(`thumb_${item.id}`);
        if (img) {
          img.dataset.id = item.id;
          observer.observe(img);
        }
      }
    });
  }

  async loadThumbnail(photoId) {
    const url = await this.getAssetBlobUrl(photoId, 'thumb');
    const imgEl = document.getElementById(`thumb_${photoId}`);
    const shimmer = document.getElementById(`shimmer_${photoId}`);
    if (imgEl && url) {
      imgEl.src = url;
      imgEl.onload = () => {
        imgEl.classList.add('loaded');
        if (shimmer) shimmer.style.opacity = '0';
      };
    }
  }

  async openLightbox(index) {
    this.currentIndex = index;
    const lb = document.getElementById('lightbox');
    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
    await this.renderLightboxSlide();
  }

  closeLightbox() {
    const lb = document.getElementById('lightbox');
    lb.classList.remove('active');
    document.body.style.overflow = '';
  }

  async navigateLightbox(direction) {
    const total = this.lightboxItems.length;
    if (total <= 1) return;

    if (this.currentIndex === total - 1 && direction === 1) {
      this.closeLightbox();
      return;
    }

    if (this.currentIndex === 0 && direction === -1) {
      return;
    }

    this.currentIndex = (this.currentIndex + direction + total) % total;
    await this.renderLightboxSlide();
  }

  async renderLightboxSlide() {
    const item = this.lightboxItems[this.currentIndex];
    const stage = document.getElementById('lightboxStage');
    
    this.updateProgressBar();

    stage.classList.add('slide-transition');

    setTimeout(() => {
      if (item.type === 'end') {
        stage.innerHTML = `
          <div class="lightbox-story-card">
            <div style="font-size: 3rem; margin-bottom: 12px;">✨</div>
            <h3 style="font-size: 2.8rem; font-weight: 700; color: #fff;">${item.text}</h3>
            <p style="font-size: 1.3rem; color: #9ca3af; margin-top: 12px;">${item.subtitle}</p>
          </div>
        `;
      } else if (item.type === 'heading') {
        stage.innerHTML = `
          <div class="lightbox-story-card">
            <h3 style="font-size: 3.2rem; font-weight: 800; color: #fff;">${item.text}</h3>
            ${item.subtitle ? `<p style="font-size: 1.5rem; color: #9ca3af; margin-top: 12px;">${item.subtitle}</p>` : ''}
          </div>
        `;
      } else if (item.type === 'narrative') {
        let html = '<div class="lightbox-story-card">';
        if (item.text) html += `<h3>${item.text.replace(/\n/g, '<br>')}</h3>`;
        if (item.subtitle) html += `<p>${item.subtitle.replace(/\n/g, '<br>')}</p>`;
        html += '</div>';
        stage.innerHTML = html;
      } else if (item.type === 'photo') {
        const thumbUrl = this.blobCache.get(`${item.id}_thumb`);
        stage.innerHTML = `
          <div class="lightbox-photo-layout">
            <div class="lightbox-img-wrapper">
              <img class="lightbox-full-img" src="${thumbUrl || ''}" id="lb_img_${item.id}">
            </div>
            ${item.caption ? `<div class="lightbox-caption-block">${item.caption}</div>` : ''}
          </div>
        `;

        this.getAssetBlobUrl(item.id, 'full').then(fullUrl => {
          const lbImg = document.getElementById(`lb_img_${item.id}`);
          if (lbImg && fullUrl) lbImg.src = fullUrl;
        });

        this.preloadAdjacent();
      }
      
      requestAnimationFrame(() => {
        stage.classList.remove('slide-transition');
      });
    }, 120);
  }

  updateProgressBar() {
    const progEl = document.getElementById('lightboxProgress');
    if (!progEl) return;
    progEl.innerHTML = '';
    
    this.lightboxItems.forEach((_, idx) => {
      const seg = document.createElement('div');
      seg.className = 'progress-segment';
      if (idx < this.currentIndex) seg.classList.add('completed');
      if (idx === this.currentIndex) seg.classList.add('active');
      seg.innerHTML = '<div class="progress-fill"></div>';
      seg.addEventListener('click', (e) => {
        e.stopPropagation();
        this.currentIndex = idx;
        this.renderLightboxSlide();
      });
      progEl.appendChild(seg);
    });
  }

  preloadAdjacent() {
    const total = this.lightboxItems.length;
    [-1, 1].forEach(offset => {
      const adjIdx = (this.currentIndex + offset + total) % total;
      const adjItem = this.lightboxItems[adjIdx];
      if (adjItem && adjItem.type === 'photo') {
        this.getAssetBlobUrl(adjItem.id, 'full');
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.galleryApp = new PhotoGalleryApp();
});
