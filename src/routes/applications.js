import express from 'express';
import multer from 'multer';
import Application from '../models/Application.js';
import Opportunity from '../models/Opportunity.js';
import User from '../models/User.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { initializeTransaction, chargeMpesa } from '../utils/paystack.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// List my applications (frontend calls GET /applications)
router.get('/', protect, async (req, res) => {
  try {
    const apps = await Application.find({ userId: req.user._id })
      .populate('opportunityId', 'title company type deadline')
      .sort({ createdAt: -1 })
      .lean();
    res.json(apps);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: list all applications
router.get('/admin/all', protect, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [applications, total] = await Promise.all([
      Application.find({})
        .populate('opportunityId', 'title company type')
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Application.countDocuments({}),
    ]);
    res.json({ applications, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: update application status (e.g. after reviewing documents)
router.patch('/admin/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const allowed = ['submitted', 'under_review', 'shortlisted', 'rejected', 'accepted'];
    const { status } = req.body;
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status. Use: submitted, under_review, shortlisted, rejected, accepted' });
    }
    const application = await Application.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    )
      .populate('opportunityId', 'title company type')
      .populate('userId', 'name email')
      .lean();
    if (!application) return res.status(404).json({ message: 'Application not found' });
    res.json(application);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/my', protect, async (req, res) => {
  try {
    const apps = await Application.find({ userId: req.user._id })
      .populate('opportunityId', 'title company type deadline')
      .sort({ createdAt: -1 })
      .lean();
    res.json(apps);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// List my saved opportunities (returns array of opportunity documents)
router.get('/saved', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('savedOpportunities').lean();
    const ids = user?.savedOpportunities || [];
    if (ids.length === 0) return res.json([]);
    const opportunities = await Opportunity.find({ _id: { $in: ids }, isActive: true }).lean();
    res.json(opportunities);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Helper: build Paystack callback URL and init payment for an application
async function getPaymentLink(application, opportunity, user) {
  const baseUrl = process.env.PAYSTACK_CALLBACK_URL || `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/app/applications`;
  const callbackUrl = `${baseUrl}?payment=done&reference=APP-${application._id}`;
  const cancelUrl = `${baseUrl.split('?')[0]}?cancelled=1`;
  // Reference must be unique per attempt (Paystack rejects duplicates on retry)
  const reference = `APP-${application._id}-${Date.now()}`;
  const { paymentLink } = await initializeTransaction({
    reference,
    amount: opportunity?.applicationFee ?? 350,
    currency: 'KES',
    callbackUrl,
    cancelUrl,
    customer: { email: user.email, name: user.name || 'Applicant' },
  });
  return paymentLink;
}

// Create application: upload resume (and recommendation letter for attachment), then return Paystack payment link
router.post(
  '/',
  protect,
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'recommendationLetter', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { opportunityId, coverLetter } = req.body;
      const opportunity = await Opportunity.findById(opportunityId);
      if (!opportunity) return res.status(404).json({ message: 'Opportunity not found' });
      if (!opportunity.isActive) return res.status(400).json({ message: 'Opportunity is closed' });

      const existing = await Application.findOne({ userId: req.user._id, opportunityId });
      if (existing && existing.status !== 'pending_payment')
        return res.status(400).json({ message: 'You have already applied' });

      const resumeFile = req.files?.resume?.[0];
      if (!resumeFile) return res.status(400).json({ message: 'Resume is required' });

      const isAttachment = opportunity.type === 'attachment';
      const recLetterFile = req.files?.recommendationLetter?.[0];
      if (isAttachment && !recLetterFile)
        return res.status(400).json({ message: 'Recommendation letter is required for attachments' });

      const resumeUrl = await uploadToCloudinary(resumeFile.buffer, 'internship-platform/resumes');
      let recommendationLetterUrl = null;
      if (recLetterFile)
        recommendationLetterUrl = await uploadToCloudinary(
          recLetterFile.buffer,
          'internship-platform/recommendations'
        );

      let application;
      if (existing && existing.status === 'pending_payment') {
        existing.resumeUrl = resumeUrl;
        existing.recommendationLetterUrl = recLetterFile ? recommendationLetterUrl : existing.recommendationLetterUrl;
        existing.coverLetter = coverLetter || existing.coverLetter;
        await existing.save();
        application = existing;
      } else {
        application = await Application.create({
          userId: req.user._id,
          opportunityId,
          resumeUrl,
          recommendationLetterUrl,
          coverLetter: coverLetter || undefined,
          status: 'pending_payment',
        });
      }

      const paymentLink = await getPaymentLink(application, opportunity, req.user);
      res.status(200).json({
        application,
        paymentLink,
        requiresPayment: true,
        amount: opportunity.applicationFee ?? 350,
        message: 'Application saved. Complete payment via the link to finish.',
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// Paystack webhook handler (mounted in index.js with raw body parser)
export async function paystackWebhookHandler(req, res) {
  res.status(200).send();
  const rawBody = req.body?.toString?.() || (typeof req.body === 'string' ? req.body : '');
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return;
  }
  const event = body?.event;
  const data = body?.data;
  if (event !== 'charge.success' || !data) return;
  const reference = data?.reference;
  const id = data?.id;
  const amount = data?.amount;
  if (!reference || !reference.startsWith('APP-')) return;
  // Reference format: APP-{applicationId} or APP-{applicationId}-{timestamp}
  const applicationId = reference.replace(/^APP-/, '').replace(/-\d+$/, '');
  const application = await Application.findById(applicationId);
  if (!application || application.status !== 'pending_payment') return;
  application.status = 'submitted';
  application.paymentTransactionId = String(id ?? reference);
  if (amount != null) application.amountPaid = Number(amount) / 100;
  await application.save();
}

// Pay for existing pending_payment application (get new Paystack payment link)
router.post('/:id/pay', protect, async (req, res) => {
  try {
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: 'pending_payment',
    }).populate('opportunityId');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const paymentLink = await getPaymentLink(application, application.opportunityId, req.user);
    res.json({
      paymentLink,
      message: 'Complete payment via the link to finish your application.',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// M-Pesa charge: user enters phone (07 or 254), we trigger STK push
router.post('/:id/charge-mpesa', protect, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: 'pending_payment',
    }).populate('opportunityId');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const opp = application.opportunityId;
    const reference = `APP-${application._id}-${Date.now()}`;
    const result = await chargeMpesa({
      reference,
      amount: opp?.applicationFee ?? 350,
      currency: 'KES',
      email: req.user.email,
      phone: phone.trim(),
      metadata: { customer_name: req.user.name || 'Applicant' },
    });
    res.json({
      reference: result.reference,
      status: result.status,
      display_text: result.display_text,
      message: result.display_text,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || 'M-Pesa charge failed' });
  }
});

// Frontend: get one application (own only)
router.get('/:id', protect, async (req, res) => {
  try {
    const app = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
      .populate('opportunityId', 'title company type deadline')
      .lean();
    if (!app) return res.status(404).json({ message: 'Application not found' });
    res.json(app);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Frontend: update application (e.g. cover letter; only when pending)
router.patch('/:id', protect, async (req, res) => {
  try {
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!application) return res.status(404).json({ message: 'Application not found' });
    if (application.status !== 'pending_payment' && application.status !== 'submitted') {
      return res.status(400).json({ message: 'Application can no longer be updated' });
    }
    const { coverLetter } = req.body;
    if (coverLetter !== undefined) application.coverLetter = coverLetter;
    await application.save();
    const updated = await Application.findById(application._id)
      .populate('opportunityId', 'title company type deadline')
      .lean();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Frontend: withdraw application (only when pending_payment or submitted)
router.delete('/:id', protect, async (req, res) => {
  try {
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const allowed = ['pending_payment', 'submitted'];
    if (!allowed.includes(application.status)) {
      return res.status(400).json({ message: 'Application cannot be withdrawn' });
    }
    await Application.findByIdAndDelete(application._id);
    res.json({ message: 'Application withdrawn' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
