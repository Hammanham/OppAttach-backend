import express from 'express';
import multer from 'multer';
import Application from '../models/Application.js';
import Opportunity from '../models/Opportunity.js';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { initiateSTKPush } from '../utils/mpesa.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// List my applications
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

// Create application: upload resume (and recommendation letter for attachment), then trigger STK push
router.post(
  '/',
  protect,
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'recommendationLetter', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { opportunityId, coverLetter, phoneNumber } = req.body;
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

      const application = await Application.create({
        userId: req.user._id,
        opportunityId,
        resumeUrl,
        recommendationLetterUrl,
        coverLetter: coverLetter || undefined,
        status: 'pending_payment',
      });

      const amount = opportunity.applicationFee || 500;
      if (!phoneNumber) {
        return res.status(200).json({
          application: application,
          requiresPayment: true,
          amount,
          message: 'Application saved. Provide phone number to complete payment via M-Pesa.',
        });
      }

      const ref = `APP-${application._id}`;
      const stk = await initiateSTKPush(
        phoneNumber,
        amount,
        ref,
        `Application fee: ${opportunity.title}`
      );
      application.mpesaCheckoutRequestId = stk.CheckoutRequestID;
      await application.save();

      res.json({
        application,
        checkoutRequestId: stk.CheckoutRequestID,
        message: 'Enter your M-Pesa PIN on your phone to complete payment.',
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// M-Pesa callback (Daraja sends result here)
router.post('/mpesa-callback', express.json(), async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const body = req.body;
  const result = body?.Body?.stkCallback;
  if (!result) return;
  const checkoutRequestId = result.CheckoutRequestID;
  const success = result.ResultCode === 0;
  const callbackMetadata = result.CallbackMetadata?.Item || [];
  const getItem = (key) => callbackMetadata.find((i) => i.Name === key)?.Value;
  const mpesaTransactionId = getItem('MpesaReceiptNumber');
  const amount = getItem('Amount');

  const application = await Application.findOne({ mpesaCheckoutRequestId: checkoutRequestId });
  if (!application) return;
  application.status = success ? 'submitted' : 'pending_payment';
  if (success) {
    application.mpesaTransactionId = mpesaTransactionId;
    application.amountPaid = amount;
  }
  application.mpesaCheckoutRequestId = undefined;
  await application.save();
});

// Pay for existing pending_payment application (STK push only)
router.post('/:id/pay', protect, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ message: 'Phone number is required' });
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: 'pending_payment',
    }).populate('opportunityId');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const amount = application.opportunityId?.applicationFee || 500;
    const ref = `APP-${application._id}`;
    const stk = await initiateSTKPush(
      phoneNumber,
      amount,
      ref,
      `Application fee: ${application.opportunityId?.title}`
    );
    application.mpesaCheckoutRequestId = stk.CheckoutRequestID;
    await application.save();
    res.json({
      checkoutRequestId: stk.CheckoutRequestID,
      message: 'Enter your M-Pesa PIN on your phone to complete payment.',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
