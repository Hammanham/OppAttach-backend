import express from 'express';
import Opportunity from '../models/Opportunity.js';
import User from '../models/User.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';

const router = express.Router();

// Admin: list all opportunities (including inactive)
router.get('/admin/all', protect, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [opportunities, total] = await Promise.all([
      Opportunity.find({}).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Opportunity.countDocuments({}),
    ]);
    res.json({ opportunities, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { category, location, type, duration, search, page = 1, limit = 12 } = req.query;
    const filter = { isActive: true };
    if (category) filter.category = new RegExp(category, 'i');
    if (location) filter.location = new RegExp(location, 'i');
    if (type) filter.type = type;
    if (duration) filter.duration = new RegExp(duration, 'i');
    if (search) {
      filter.$or = [
        { title: new RegExp(search, 'i') },
        { company: new RegExp(search, 'i') },
        { description: new RegExp(search, 'i') },
      ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [opportunities, total] = await Promise.all([
      Opportunity.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Opportunity.countDocuments(filter),
    ]);
    res.json({ opportunities, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Toggle save opportunity for current user (must be before GET /:id)
router.post('/:id/save', protect, async (req, res) => {
  try {
    const opp = await Opportunity.findById(req.params.id);
    if (!opp) return res.status(404).json({ message: 'Opportunity not found' });
    const user = await User.findById(req.user._id).select('savedOpportunities');
    if (!user) return res.status(401).json({ message: 'User not found' });
    const id = opp._id;
    const list = user.savedOpportunities || [];
    const idx = list.findIndex((s) => s.toString() === id.toString());
    if (idx >= 0) {
      list.splice(idx, 1);
      user.savedOpportunities = list;
      await user.save();
      return res.json({ saved: false });
    }
    list.push(id);
    user.savedOpportunities = list;
    await user.save();
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const opp = await Opportunity.findById(req.params.id).lean();
    if (!opp) return res.status(404).json({ message: 'Opportunity not found' });
    res.json(opp);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post(
  '/',
  protect,
  adminOnly,
  [
    body('title').trim().notEmpty(),
    body('company').trim().notEmpty(),
    body('type').isIn(['internship', 'attachment']),
    body('description').trim().notEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const opportunity = await Opportunity.create(req.body);
      res.status(201).json(opportunity);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.patch('/:id', protect, adminOnly, async (req, res) => {
  try {
    const opportunity = await Opportunity.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!opportunity) return res.status(404).json({ message: 'Opportunity not found' });
    res.json(opportunity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
