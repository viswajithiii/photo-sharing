/**
 * Client-side App Logic & Decryption Engine for Secure Photo Gallery
 */

class PhotoGalleryApp {
  constructor() {
    this.rawManifest = typeof GALLERY_DATA !== 'undefined' ? GALLERY_DATA : null;
    this.key = null;
    this.manifest = null;
    this.blobCache = new Map();
    this.currentIndex = 0;
    this.lightboxItems = [];
    this.targetSlug = null;
    
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

  async hashSlug(str) {
    const clean = str.replace(/^\/+|\/+$/g, '').trim();
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clean));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  getTargetSlug() {
    const hash = window.location.hash.replace('#', '').trim();
    if (hash) return hash;
    const params = new URLSearchParams(window.location.search);
    if (params.get('album')) return params.get('album');
    if (params.get('a')) return params.get('a');
    return null;
  }

  async init() {
    this.bindEvents();

    if (!this.rawManifest) {
      document.getElementById('galleryDescription').textContent = "Error: GALLERY_DATA not found.";
      return;
    }

    this.rawTargetSlug = this.getTargetSlug();
    this.targetSlug = this.rawTargetSlug ? await this.hashSlug(this.rawTargetSlug) : null;

    const showcaseEl = document.getElementById('showcaseContainer');
    const feedEl = document.getElementById('feedContainer');
    const authEl = document.getElementById('authOverlay');
    const lockBtn = document.getElementById('lockBtn');
    const headerEl = document.querySelector('.app-header');

    if (!this.targetSlug || !this.rawManifest.albums || !this.rawManifest.albums[this.targetSlug]) {
      if (showcaseEl) showcaseEl.style.display = 'block';
      if (feedEl) feedEl.style.display = 'none';
      if (authEl) authEl.classList.add('hidden');
      if (headerEl) headerEl.style.display = 'none';
      return;
    }

    if (showcaseEl) showcaseEl.style.display = 'none';
    if (headerEl) headerEl.style.display = 'block';
    if (lockBtn) lockBtn.style.display = 'inline-flex';

    const albumBundle = this.rawManifest.albums[this.targetSlug];
    if (!albumBundle.encrypted) {
      this.manifest = albumBundle.manifest;
      if (authEl) authEl.classList.add('hidden');
      this.renderFeed();
      return;
    }

    const savedPwd = sessionStorage.getItem('gallery_pwd_' + this.targetSlug);
    if (savedPwd) {
      const success = await this.unlock(savedPwd, true);
      if (success) return;
    }
    
    if (authEl) authEl.classList.remove('hidden');
  }

  bindEvents() {
    const authForm = document.getElementById('authForm');
    if (authForm) {
      authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pwd = document.getElementById('passwordInput').value;
        await this.unlock(pwd, false);
      });
    }

    const lockBtn = document.getElementById('lockBtn');
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        if (this.targetSlug) {
          sessionStorage.removeItem('gallery_pwd_' + this.targetSlug);
        }
        window.location.reload();
      });
    }

    window.addEventListener('hashchange', () => {
      window.location.reload();
    });

    const expBack = document.getElementById('photoExpandBack');
    if (expBack) {
      expBack.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePhotoExpansion(false);
      });
    }

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

    const stage = document.getElementById('lightboxStage');
    if (stage) {
      stage.addEventListener('touchstart', (e) => {
        this.touchStartX = e.changedTouches[0].clientX;
      }, { passive: true });

      stage.addEventListener('touchend', (e) => {
        if (e.target.closest('button, a')) return;
        this.touchEndX = e.changedTouches[0].clientX;
        this.handleTouchOrSwipe(e);
      }, { passive: true });

      stage.addEventListener('click', (e) => {
        if (e.target.closest('button, a')) return;
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
        this.handleStageTap(e.clientX);
      });
    }
  }

  handleTouchOrSwipe(e) {
    const threshold = 40;
    const diff = this.touchStartX - this.touchEndX;
    if (Math.abs(diff) > threshold) {
      if (diff > 0) this.navigateLightbox(1);
      else this.navigateLightbox(-1);
    } else {
      const tapX = e.changedTouches[0].clientX;
      this.handleStageTap(tapX);
    }
  }

  handleStageTap(tapX) {
    const screenWidth = window.innerWidth;
    if (tapX < screenWidth * 0.30) {
      this.navigateLightbox(-1);
    } else if (tapX > screenWidth * 0.70) {
      this.navigateLightbox(1);
    } else {
      const currentItem = this.lightboxItems[this.currentIndex];
      if (currentItem && currentItem.type === 'photo') {
        this.togglePhotoExpansion(!this.isPhotoExpanded);
      }
    }
  }

  togglePhotoExpansion(expand) {
    this.isPhotoExpanded = expand;
    const lb = document.getElementById('lightbox');
    const backBtn = document.getElementById('photoExpandBack');
    if (!lb) return;
    if (expand) {
      lb.classList.add('photo-expanded');
      if (backBtn) backBtn.style.display = 'inline-flex';
    } else {
      lb.classList.remove('photo-expanded');
      if (backBtn) backBtn.style.display = 'none';
    }
  }

  async unlock(password, isSilent = false) {
    const errEl = document.getElementById('authError');
    if (errEl) errEl.style.display = 'none';

    if (!this.targetSlug || !this.rawManifest.albums[this.targetSlug]) return false;
    const albumBundle = this.rawManifest.albums[this.targetSlug];

    try {
      const salt = this.base64ToArrayBuffer(albumBundle.salt);
      const iv = this.base64ToArrayBuffer(albumBundle.iv);
      const ciphertext = this.base64ToArrayBuffer(albumBundle.ciphertext);

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

      sessionStorage.setItem('gallery_pwd_' + this.targetSlug, password);
      const authEl = document.getElementById('authOverlay');
      if (authEl) authEl.classList.add('hidden');
      this.renderFeed();
      return true;

    } catch (e) {
      if (!isSilent) {
        if (errEl) errEl.style.display = 'block';
        const input = document.getElementById('passwordInput');
        if (input) {
          input.value = '';
          input.focus();
        }
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
    if (!id) return null;
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
    document.getElementById('galleryTitle').textContent = this.manifest.title || "Private Collection";
    document.getElementById('galleryDescription').textContent = this.manifest.description || "";

    const container = document.getElementById('feedContainer');
    if (container) {
      container.style.display = 'grid';
      container.innerHTML = '';
    }
    this.lightboxItems = [];

    const feedList = this.manifest.feed || [];
    feedList.forEach((item, idx) => {
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

    this.lightboxItems.push({
      type: 'end',
      text: "End of Collection",
      subtitle: "Swipe right or press arrow key once more to exit full-screen view"
    });

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

    const feedList = this.manifest.feed || [];
    feedList.forEach(item => {
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
    this.togglePhotoExpansion(false);
    const lb = document.getElementById('lightbox');
    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
    await this.renderLightboxSlide();
  }

  closeLightbox() {
    this.togglePhotoExpansion(false);
    const lb = document.getElementById('lightbox');
    lb.classList.remove('active');
    document.body.style.overflow = '';
  }

  async navigateLightbox(direction) {
    this.togglePhotoExpansion(false);
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
