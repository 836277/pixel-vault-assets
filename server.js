const express = require('express');
const multer = require('multer');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 配置区 ==========
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '836277';
const GITHUB_REPO = process.env.GITHUB_REPO || 'pixel-vault-assets';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'master';
const ASSETS_FOLDER = 'assets';
const MANIFEST_FILE = 'assets.json';
// ============================

const ALLOWED_TYPES = new Set([
  'application/zip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/x-zip-compressed',
  'application/octet-stream',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'
]);
const MAX_FILE_SIZE = 50 * 1024 * 1024;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型'), false);
    }
  }
});

// 上传 API
app.post('/api/upload', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'GitHub Token 未配置' });
    }

    const file = req.files && req.files.file ? req.files.file[0] : null;
    const image = req.files && req.files.image ? req.files.image[0] : null;
    const { title, description, type, sizes, category, tags } = req.body;

    if (!file) return res.status(400).json({ error: '缺少下载文件' });
    if (!image) return res.status(400).json({ error: '缺少展示图片' });

    const timestamp = Date.now();
    const id = 'asset_' + timestamp;
    const ext = path.extname(file.originalname).toLowerCase();
    const imageExt = path.extname(image.originalname).toLowerCase() || '.png';

    const fileName = timestamp + '-file' + ext;
    const imageName = timestamp + '-preview' + imageExt;

    // 读取 manifest
    let manifest = [];
    try {
      const manifestUrl = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + MANIFEST_FILE + '?ref=' + GITHUB_BRANCH;
      const manifestResp = await axios.get(manifestUrl, {
        headers: { Authorization: 'token ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json' }
      });
      if (manifestResp.data.content) {
        manifest = JSON.parse(Buffer.from(manifestResp.data.content, 'base64').toString('utf-8'));
      }
    } catch (e) {
      // manifest 不存在，正常
    }

    // 上传下载文件
    const fileContent = file.buffer.toString('base64');
    const filePath = ASSETS_FOLDER + '/' + fileName;
    const fileUrl = 'https://cdn.jsdelivr.net/gh/' + GITHUB_OWNER + '/' + GITHUB_REPO + '@' + GITHUB_BRANCH + '/' + filePath;

    // 上传展示图片
    const imageContent = image.buffer.toString('base64');
    const imagePath = ASSETS_FOLDER + '/' + imageName;
    const imageUrl = 'https://cdn.jsdelivr.net/gh/' + GITHUB_OWNER + '/' + GITHUB_REPO + '@' + GITHUB_BRANCH + '/' + imagePath;

    // 并行上传
    await Promise.all([
      uploadToGithub(filePath, fileContent, 'Upload file: ' + file.originalname),
      uploadToGithub(imagePath, imageContent, 'Upload image: ' + image.originalname)
    ]);

    // 解析 sizes 和 tags
    let sizeArr = [];
    try { sizeArr = sizes ? (Array.isArray(sizes) ? sizes : JSON.parse(sizes)) : []; } catch (e) { sizeArr = []; }
    let tagArr = [];
    try { tagArr = tags ? (Array.isArray(tags) ? tags : JSON.parse(tags)) : []; } catch (e) { tagArr = []; }

    const asset = {
      id,
      title: title || '未命名素材',
      description: description || '',
      type: type || 'free',
      sizes: sizeArr,
      category: category || 'items',
      tags: tagArr,
      fileName: file.originalname,
      fileSize: file.size,
      fileType: file.mimetype,
      fileUrl,
      imageUrl,
      createdAt: new Date().toISOString(),
      downloads: 0
    };

    manifest.unshift(asset);

    const manifestContent = JSON.stringify(manifest, null, 2);
    await updateGithubFile(MANIFEST_FILE, manifestContent, 'Update assets manifest');

    res.json({ success: true, asset });
  } catch (err) {
    console.error('Upload error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: (err.response && err.response.data && err.response.data.message) ? err.response.data.message : (err.message || '上传失败') });
  }
});

// 获取素材列表
app.get('/api/assets', async (req, res) => {
  try {
    if (!GITHUB_TOKEN) return res.json([]);

    const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + MANIFEST_FILE + '?ref=' + GITHUB_BRANCH;
    const resp = await axios.get(url, {
      headers: { Authorization: 'token ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json' }
    });

    if (resp.data.content) {
      const manifest = JSON.parse(Buffer.from(resp.data.content, 'base64').toString('utf-8'));
      return res.json(manifest);
    }
    res.json([]);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      res.json([]);
    } else {
      console.error('Fetch assets error:', e.message);
      res.status(500).json({ error: '获取素材列表失败' });
    }
  }
});

// ========== GitHub API 工具函数 ==========

async function uploadToGithub(filePath, contentBase64, message) {
  const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + encodeURIComponent(filePath);

  let sha = null;
  try {
    const existing = await axios.get(url, {
      headers: { Authorization: 'token ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json' },
      params: { ref: GITHUB_BRANCH }
    });
    sha = existing.data.sha;
  } catch (e) {
    if (e.response && e.response.status !== 404) throw e;
  }

  const payload = {
    message: message,
    content: contentBase64,
    branch: GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;

  await axios.put(url, payload, {
    headers: { Authorization: 'token ' + GITHUB_TOKEN, Accept: 'application/vnd.github.v3+json' }
  });
}

async function updateGithubFile(filePath, content, message) {
  await uploadToGithub(filePath, Buffer.from(content).toString('base64'), message);
}

// ========== 错误处理 ==========

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件超过 50MB 限制' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Vercel serverless 模式
if (process.env.VERCEL === 'true') {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log('PixelVault Upload Server running on port ' + PORT);
    console.log('GitHub repo: ' + GITHUB_OWNER + '/' + GITHUB_REPO);
  });
}
