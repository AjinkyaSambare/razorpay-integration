const express = require('express');
const bodyParser = require('body-parser');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const GhostAdminAPI = require('@tryghost/admin-api');
require('dotenv').config();
const cors = require('cors');
const helmet = require('helmet'); // Add security headers

const app = express();

// Security middleware
app.use(helmet());
app.use(bodyParser.json());

// Configure CORS more securely for production
app.use(cors({
    // In production, specify your Ghost site domain instead of '*'
    origin: process.env.GHOST_SITE_URL || '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Initialize Ghost Admin API
const ghost = new GhostAdminAPI({
    url: process.env.GHOST_API_URL,
    key: process.env.GHOST_ADMIN_API_KEY,
    version: 'v5.0'
});

// Create a Razorpay order
app.post('/api/razorpay/create-order', async (req, res) => {
    try {
        const plan = req.body.plan;
        const email = req.body.email || '';
        
        // Define pricing based on plan
        const pricingDetails = {
            monthly: {
                amount: 900,  // 9.00 INR
                currency: 'INR',
                description: 'Monthly membership'
            },
            yearly: {
                amount: 9900,  // 99.00 INR
                currency: 'INR',
                description: 'Yearly membership'
            }
        };
        
        const selectedPlan = pricingDetails[plan] || pricingDetails.monthly;
        
        // Create order in Razorpay
        const order = await razorpay.orders.create({
            amount: selectedPlan.amount,
            currency: selectedPlan.currency,
            receipt: `receipt_${Date.now()}`,
            payment_capture: 1
        });
        
        // Log successful order creation (but not sensitive info)
        console.log(`Order created: ${order.id} for plan: ${plan}`);
        
        res.json({
            success: true,
            orderId: order.id,
            amount: selectedPlan.amount,
            currency: selectedPlan.currency,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID,
            siteName: process.env.SITE_NAME || 'Your Site Name',
            planDescription: selectedPlan.description,
            siteImage: process.env.SITE_LOGO || 'https://yoursite.com/logo.png',
            customerEmail: email
        });
    } catch (error) {
        console.error('Error creating Razorpay order:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to create order'
        });
    }
});

// Verify Razorpay payment
app.post('/api/razorpay/verify-payment', async (req, res) => {
    try {
        // Verify signature
        const {
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_signature,
            email,
            name
        } = req.body;
        
        if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
            return res.status(400).json({
                success: false,
                error: 'Missing payment information'
            });
        }
        
        const generatedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');
        
        if (generatedSignature !== razorpay_signature) {
            console.warn(`Invalid signature for payment ${razorpay_payment_id}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid signature'
            });
        }
        
        // Create member in Ghost or update existing member with subscription
        try {
            // First check if member exists
            let member;
            try {
                const existingMembers = await ghost.members.browse({
                    filter: `email:'${email}'`
                });
                
                if (existingMembers.length > 0) {
                    // Update existing member
                    member = await ghost.members.edit({
                        id: existingMembers[0].id,
                        labels: [...(existingMembers[0].labels || []), 'razorpay-customer'],
                        note: `${existingMembers[0].note || ''} Razorpay payment: ${razorpay_payment_id}`
                    });
                } else {
                    // Create new member
                    member = await ghost.members.add({
                        email: email,
                        name: name,
                        subscribed: true,
                        labels: ['razorpay-customer'],
                        note: `Razorpay customer: ${razorpay_payment_id}`
                    });
                }
                
                console.log(`Successfully processed member: ${email} for payment: ${razorpay_payment_id}`);
                
                res.json({
                    success: true,
                    memberId: member.id,
                    successUrl: '/membership-success/'
                });
            } catch (ghostError) {
                console.error('Error with Ghost API:', ghostError.message);
                // Still return success to user but log the error
                res.json({
                    success: true,
                    successUrl: '/membership-success/'
                });
            }
        } catch (memberError) {
            console.error('Error processing member:', memberError.message);
            res.status(500).json({
                success: false,
                error: 'Payment verified but failed to process membership'
            });
        }
    } catch (error) {
        console.error('Error verifying Razorpay payment:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to verify payment'
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});