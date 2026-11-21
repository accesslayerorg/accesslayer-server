import nodemailer from 'nodemailer';
import { envConfig } from '../config';
import { logger } from './logger.utils';
export interface ISendMailOptions {
   to: string;
   subject: string;
   text?: string;
   html?: string;
   attachments?: any[];
}

// Create reusable transporter
const createTransporter = () => {
   const { GMAIL_USER, GMAIL_APP_PASSWORD } = envConfig;

   if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return null;
   }

   return nodemailer.createTransport({
      service: 'gmail',
      auth: {
         user: GMAIL_USER,
         pass: GMAIL_APP_PASSWORD,
      },
   });
};

export const SendMail = async ({
   to,
   subject,
   text,
   html,
   attachments,
}: ISendMailOptions) => {
   const { GMAIL_USER, GMAIL_APP_PASSWORD } = envConfig;

   // Skip email in development if not configured
   if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      logger.info({ to, subject }, 'Email skipped (Gmail not configured)');
      return true;
   }

   try {
      const transporter = createTransporter();

      if (!transporter) {
         logger.error('Could not create email transporter');
         return false;
      }

      const mailOptions = {
         from: `Access Layer <${GMAIL_USER}>`,
         to: to,
         subject: subject,
         text: text,
         html: html || generateProjectTemplate(text || '', subject),
         ...(attachments && attachments.length > 0 && { attachments }),
      };

      const info = await transporter.sendMail(mailOptions);

      logger.info(
         { to, messageId: info.messageId },
         'Email sent successfully via Gmail'
      );
      return true;
   } catch (error) {
      logger.error({ error, to }, 'Failed to send email via Gmail');
      return false;
   }
};

// Helper function - adjust based on your actual template
function generateProjectTemplate(text: string, subject: string): string {
   return `
      <!DOCTYPE html>
      <html>
      <head>
         <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #f4f4f4; padding: 20px; text-align: center; }
         </style>
      </head>
      <body>
         <div class="container">
            <div class="header">
               <h2>${subject}</h2>
            </div>
            <div style="padding: 20px;">
               ${text}
            </div>
         </div>
      </body>
      </html>
   `;
}

// Async version that doesn't block API responses
export const SendMailAsync = async ({
   to,
   subject,
   text,
   html,
   attachments,
}: ISendMailOptions) => {
   // Fire and forget - don't wait for response
   SendMail({ to, subject, text, html, attachments })
      .then(() => {
         logger.info({ to }, 'Async email sent');
      })
      .catch(error => {
         logger.error({ error, to }, 'Async email failed');
      });
};

// Starter email templates for Access Layer flows.
export const EmailTemplates = {
   creatorApplicationReceived: (
      submitterName: string,
      referenceId: string,
      handle: string
   ) => `
      <h2>We received your Access Layer submission</h2>
      <p>Dear ${submitterName},</p>
      <p>We have received your creator application for <strong>${handle}</strong>.</p>
      <p>Your reference ID is: <strong>${referenceId}</strong></p>
      <p>Our team will review the submission and update the status accordingly.</p>
      <p>Thank you for building with Access Layer.</p>
   `,

   adminActivityNotification: (activity: any) => `
      <h2>New Access Layer activity requires review</h2>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
         <h3>Activity Details</h3>
         <p><strong>Reference:</strong> ${activity.id}</p>
         <p><strong>Actor:</strong> ${activity.actorName || 'Unknown'}</p>
         <p><strong>Email:</strong> ${activity.actorEmail || 'Not provided'}</p>
         <p><strong>Submitted:</strong> ${new Date(activity.createdAt).toLocaleString()}</p>
      </div>

      <div style="background: #e8f5e8; padding: 20px; border-radius: 8px; margin: 20px 0;">
         <h3>Marketplace Context</h3>
         <p><strong>Type:</strong> ${activity.type || 'Not specified'}</p>
         <p><strong>Target:</strong> ${activity.target || 'Not specified'}</p>
         <p><strong>Summary:</strong> ${activity.summary || 'No summary provided'}</p>
      </div>

      <div style="text-align: center; margin: 30px 0;">
         <a href="${envConfig.FRONTEND_URL}" 
            style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            Open Access Layer
         </a>
      </div>

      <p style="color: #666; font-size: 14px; margin-top: 30px;">
         Review this activity in the admin tools and update the related status as appropriate.
      </p>
   `,

   adminInvitation: (
      adminName: string,
      inviterName: string,
      role: string,
      inviteLink: string
   ) => `
      <h2>You've been invited to join as an admin</h2>
      <p>Dear ${adminName},</p>
      <p>You have been invited by ${inviterName} to join the Access Layer admin panel as a <strong>${role}</strong>.</p>
      
      <div style="background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
         <h3>🛡️ Your Role</h3>
         <p><strong>${role}</strong></p>
         ${
            role === 'SYSTEM_ADMIN'
               ? '<p>As a System Admin, you have full access to manage users, creator operations, and system settings.</p>'
               : '<p>As an Admin, you can review marketplace activity and view analytics.</p>'
         }
      </div>

      <div style="text-align: center; margin: 30px 0;">
         <p>Click the button below to accept your invitation:</p>
         <a href="${inviteLink}" style="background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 16px;">
            🚀 Accept Invitation
         </a>
      </div>

      <div style="background: #fff3cd; padding: 15px; border-radius: 6px; margin: 20px 0;">
         <p><strong>⏰ Important:</strong> This invitation will expire in 7 days.</p>
      </div>

      <p>If you didn't expect this invitation, you can safely ignore this email.</p>
   `,

   statusUpdate: (
      submitterName: string,
      referenceId: string,
      status: string,
      adminNotes?: string
   ) => `
      <h2>Status Update</h2>
      <p>Dear ${submitterName},</p>
      <p>Your Access Layer request (ID: <strong>${referenceId}</strong>) has been <strong style="text-transform: capitalize; color: ${
         status === 'APPROVED'
            ? '#28a745'
            : status === 'REJECTED'
              ? '#dc3545'
              : '#6c757d'
      };">${status.toLowerCase()}</strong>.</p>
      
      ${
         adminNotes
            ? `
         <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>💬 Admin Notes</h3>
            <p>${adminNotes}</p>
         </div>
      `
            : ''
      }

      ${
         status === 'APPROVED'
            ? `
         <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Approved</h3>
            <p>Your request has been approved and is ready for the next Access Layer workflow.</p>
         </div>
      `
            : ''
      }

      ${
         status === 'REJECTED'
            ? `
         <div style="background: #f8d7da; border: 1px solid #f5c6cb; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Rejected</h3>
            <p>This request did not meet the current review criteria. Please review the admin notes above for details.</p>
         </div>
      `
            : ''
      }

      <p>Thank you for building with Access Layer.</p>
   `,

   passwordReset: (adminName: string, resetLink: string) => `
      <h2>🔐 Password Reset Request</h2>
      <p>Dear ${adminName},</p>
      <p>We received a request to reset your password for the Access Layer admin panel.</p>
      
      <div style="text-align: center; margin: 30px 0;">
         <a href="${resetLink}" style="background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            🔑 Reset Password
         </a>
      </div>

      <div style="background: #fff3cd; padding: 15px; border-radius: 6px; margin: 20px 0;">
         <p><strong>⏰ Important:</strong> This link will expire in 1 hour for security reasons.</p>
      </div>

      <p>If you didn't request this password reset, you can safely ignore this email.</p>
   `,
};
