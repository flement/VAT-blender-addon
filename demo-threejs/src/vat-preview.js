import { DataUtils } from "three";

// Realtime 2D preview of the VAT textures, drawn in bake-memory row order
// (top = mem row 0). The playhead marks, per vertex-block b, the mem row the
// shader samples at frame f: m = (K-1-b) * F + f  (F = frames, K = wraps).
export function buildPreview({
  posTexture,
  normalTexture,
  frames,
  numWraps,
  posCanvas,
  nrmCanvas,
  posDims,
  nrmDims,
  statusEl,
}) {
  const F = frames;
  const K = numWraps;
  const W = posTexture.image.width;
  const H = posTexture.image.height;
  let lastFrame = -1;

  // --- Positions offscreen: EXR half data is GL-flipped by the loader,
  // data row d = mem row H-1-d. Values normalized by global RGB min/max.
  const data = posTexture.image.data;
  let posOff = null;
  let min = 0;
  let max = 1;
  if (data && data.length === W * H * 4) {
    min = Infinity;
    max = -Infinity;
    const n = data.length / 4;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = DataUtils.fromHalfFloat(data[i * 4 + c]);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const span = max - min || 1;
    posOff = document.createElement("canvas");
    posOff.width = W;
    posOff.height = H;
    const pctx = posOff.getContext("2d");
    const pimg = pctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const drow = H - 1 - y;
      for (let x = 0; x < W; x++) {
        const si = (drow * W + x) * 4;
        const di = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          pimg.data[di + c] = Math.round(
            ((DataUtils.fromHalfFloat(data[si + c]) - min) / span) * 255,
          );
        }
        pimg.data[di + 3] = 255;
      }
    }
    pctx.putImageData(pimg, 0, 0);
  }

  // --- Positions fallback: PNG (normalize path) loads as an HTML image
  // (no .data): rasterize it and normalize its 8-bit channels by min/max,
  // same mem-row mapping as the EXR branch above.
  if (!posOff && posTexture.image && posTexture.image.width) {
    const src = posTexture.image;
    const tmp = document.createElement("canvas");
    tmp.width = W;
    tmp.height = H;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(src, 0, 0, W, H);
    const px = tctx.getImageData(0, 0, W, H).data;
    min = Infinity;
    max = -Infinity;
    const n = W * H;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = px[i * 4 + c] / 255;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const span = max - min || 1;
    posOff = document.createElement("canvas");
    posOff.width = W;
    posOff.height = H;
    const pctx = posOff.getContext("2d");
    const pimg = pctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const drow = H - 1 - y;
      for (let x = 0; x < W; x++) {
        const si = (drow * W + x) * 4;
        const di = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          pimg.data[di + c] = Math.round(((px[si + c] / 255 - min) / span) * 255);
        }
        pimg.data[di + 3] = 255;
      }
    }
    pctx.putImageData(pimg, 0, 0);
  }

  // --- Normals offscreen: PNG file rows are top-down = mem bottom-up,
  // so flip vertically on draw to land in mem order like positions.
  // Optional: without a normals texture the canvas stays empty.
  const nimg = normalTexture?.image;
  const nW = nimg?.width || W;
  const nH = nimg?.height || H;
  let nrmOff = null;
  if (nimg) {
    nrmOff = document.createElement("canvas");
    nrmOff.width = nW;
    nrmOff.height = nH;
    const nctx = nrmOff.getContext("2d");
    nctx.save();
    nctx.translate(0, nH);
    nctx.scale(1, -1);
    nctx.drawImage(nimg, 0, 0, nW, nH);
    nctx.restore();
  }

  posCanvas.width = W;
  posCanvas.height = H;
  nrmCanvas.width = nW;
  nrmCanvas.height = nH;
  posDims.textContent = `${W}x${H}`;
  nrmDims.textContent = nimg ? `${nW}x${nH}` : '—';

  function paint(canvas, off, rows) {
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (off) ctx.drawImage(off, 0, 0);
    else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const m of rows) {
      ctx.moveTo(0, m + 0.5);
      ctx.lineTo(canvas.width, m + 0.5);
    }
    ctx.stroke();
  }

  function update(f) {
    const fi = ((Math.floor(f) % F) + F) % F;
    if (fi === lastFrame) return;
    lastFrame = fi;
    const rows = [];
    for (let b = 0; b < K; b++) rows.push((K - 1 - b) * F + fi);
    paint(posCanvas, posOff, rows);
    paint(nrmCanvas, nrmOff, rows);
    statusEl.textContent = `frame ${fi} · mem rows [${rows.join(", ")}] · offsets [${min.toFixed(3)}, ${max.toFixed(3)}]`;
  }

  update(0);
  return { update };
}

// 2D preview of decoded storage buffers (.bin): bake-memory row order
// (top = mem row 0, which holds the LAST frame — frames are stored
// reversed, like the texture path). The playhead marks the mem row the
// shader samples at frame f: m = F-1-f. Columns = vertices strided to
// fit. Offsets normalized by the meta range, normals mapped from [-1, 1].
// Same { update } contract as buildPreview.
export function buildStoragePreview({
  offsets,
  normals,
  meta,
  posCanvas,
  nrmCanvas,
  posDims,
  nrmDims,
  statusEl,
}) {
  const V = meta.vertexCount;
  const F = meta.frameCount;
  const stride = Math.max(1, Math.ceil(V / 1024));
  const W = Math.ceil(V / stride);
  const span = meta.maxOffset - meta.minOffset || 1;
  let lastFrame = -1;

  function paintArrays(src, isNormal) {
    const off = document.createElement("canvas");
    off.width = W;
    off.height = F;
    const ctx = off.getContext("2d");
    const img = ctx.createImageData(W, F);
    for (let f = 0; f < F; f++) {
      for (let x = 0; x < W; x++) {
        const v = Math.min(x * stride, V - 1);
        const si = (f * V + v) * 4;
        const di = (f * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const t = isNormal ? src[si + c] * 0.5 + 0.5 : (src[si + c] - meta.minOffset) / span;
          img.data[di + c] = Math.max(0, Math.min(255, Math.round(t * 255)));
        }
        img.data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return off;
  }

  const posOff = paintArrays(offsets, false);
  const nrmOff = normals ? paintArrays(normals, true) : null;
  posCanvas.width = W;
  posCanvas.height = F;
  nrmCanvas.width = W;
  nrmCanvas.height = F;
  posDims.textContent = `${V}v x ${F}f`;
  nrmDims.textContent = normals ? `${V}v x ${F}f` : '—';

  function paint(canvas, off, fi) {
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (off) ctx.drawImage(off, 0, 0);
    else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, fi + 0.5);
    ctx.lineTo(canvas.width, fi + 0.5);
    ctx.stroke();
  }

  function update(f) {
    const fi = ((Math.floor(f) % F) + F) % F;
    if (fi === lastFrame) return;
    lastFrame = fi;
    paint(posCanvas, posOff, F - 1 - fi);
    paint(nrmCanvas, nrmOff, F - 1 - fi);
    statusEl.textContent =
      `frame ${fi} · mem row ${F - 1 - fi} · ${V} verts x ${F} frames · offsets [${meta.minOffset.toFixed(3)}, ${meta.maxOffset.toFixed(3)}]${normals ? '' : ' · no normals (geometry)'}`;
  }

  update(0);
  return { update };
}
