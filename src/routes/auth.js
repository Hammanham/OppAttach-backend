import express from 'express';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { OAuth2Client } from 'google-auth-library';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function generateToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { name, email, password } = req.body;
      const existing = await User.findOne({ email });
      if (existing) return res.status(400).json({ message: 'Email already registered' });
      const isAdmin = process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
      const user = await User.create({ name, email, password, authProvider: 'email', role: isAdmin ? 'admin' : 'student' });
      const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar };
      res.status(201).json({ user: u, token: generateToken(user._id) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { email, password } = req.body;
      const user = await User.findOne({ email });
      if (!user || !user.password) return res.status(401).json({ message: 'Invalid credentials' });
      const match = await user.matchPassword(password);
      if (!match) return res.status(401).json({ message: 'Invalid credentials' });
      const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar };
      res.json({ user: u, token: generateToken(user._id) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.post('/google', async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ message: 'Google sign-in is not configured (missing GOOGLE_CLIENT_ID)' });
  }
  try {
    const idToken = req.body.idToken;
    const accessToken = req.body.accessToken;
    let payload;
    if (idToken) {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } else if (accessToken) {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return res.status(401).json({ message: 'Invalid Google token' });
      const userinfo = await r.json();
      payload = { sub: userinfo.sub, name: userinfo.name, email: userinfo.email, picture: userinfo.picture };
    } else {
      return res.status(400).json({ message: 'idToken or accessToken required' });
    }
    const { sub: googleId, name, email, picture } = payload;
    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (!user) {
      user = await User.create({
        name,
        email,
        googleId,
        avatar: picture,
        authProvider: 'google',
      });
    } else if (!user.googleId) {
      user.googleId = googleId;
      user.avatar = user.avatar || picture;
      await user.save();
    }
    const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar };
    res.json({ user: u, token: generateToken(user._id) });
  } catch (err) {
    console.error('Google sign-in error:', err.message);
    const message =
      err.message?.includes('audience') || err.message?.includes('Audience')
        ? 'Google client ID mismatch. Use the same OAuth client ID in frontend (VITE_GOOGLE_CLIENT_ID) and backend (GOOGLE_CLIENT_ID), and add your site URL to Authorized JavaScript origins in Google Cloud Console.'
        : err.message?.includes('expired')
          ? 'Google sign-in expired. Try again.'
          : 'Invalid Google token. Check that your site is in Authorized JavaScript origins in Google Cloud Console.';
    res.status(401).json({ message });
  }
});

router.get('/me', protect, async (req, res) => {
  res.json(req.user);
});

// Frontend compatibility: logout (stateless JWT — client clears token)
router.post('/logout', (req, res) => {
  res.json({ ok: true });
});

// Frontend compatibility: refresh — return current user and new token
router.post('/refresh', protect, async (req, res) => {
  const user = req.user;
  const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar };
  res.json({ user: u, token: generateToken(user._id) });
});

export default router;
