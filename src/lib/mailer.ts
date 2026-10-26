import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

export async function sendVerificationEmail(to: string, code: string) {
  await transporter.sendMail({
    from: `"School Results" <${process.env.GMAIL_USER}>`,
    to,
    subject: "Your verification code",
    text: `Your 6-digit verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your 6-digit verification code is:</p>
           <h2 style="letter-spacing:4px">${code}</h2>
           <p>It expires in 10 minutes.</p>`,
  });
}