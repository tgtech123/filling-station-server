import { Request, Response } from "express";
import { transporter } from "../middlewares/transporter.middleware";

export const ContactUs = async (req:Request, res:Response) => {
    const {firstName, lastName, phoneNumber, email, message} = req.body

    if(!firstName || !lastName || !phoneNumber || !email || !message){
        return res.status(400).json({message: "please fill the required field"})
    }
try {
    await transporter.sendMail({
        to: "oboh.thankgod1@gmail.com",
        subject: `Contact Message from ${firstName + " " + lastName}`,
        html: `
  <div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
    <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.1); overflow:hidden;">

      <!-- Header -->
      <div style="background:#007BFF; color:white; padding:20px; text-align:center;">
        <h2 style="margin:0;">New Contact Message</h2>
      </div>

      <!-- Body -->
      <div style="padding:20px; color:#333;">
        <p><strong style="color:#007BFF;">From:</strong> ${firstName} ${lastName}</p>
        <p><strong style="color:#007BFF;">Email:</strong> ${email}</p>
        <p><strong style="color:#007BFF;">Phone:</strong> ${phoneNumber}</p>

        <div style="margin:20px 0; padding:15px; background:#f8f9fa; border-left:4px solid #ffc107; border-radius:4px;">
          <p style="margin:0; font-size:15px; line-height:1.6; color:#333;">
            ${message}
          </p>
        </div>

        <p style="font-size:13px; color:#666; margin-top:30px;">
          ⚠ Please respond to this message as soon as possible.
        </p>
      </div>

      <!-- Footer -->
      <div style="background:#f1f1f1; padding:15px; text-align:center; font-size:12px; color:#555;">
        <p style="margin:0;">&copy; ${new Date().getFullYear()} Flourish Station. All rights reserved.</p>
      </div>

    </div>
  </div>
`

    })

    return res.status(200).json({message:"Your mssage was sent successfully"})
    
} catch (error: any) {
    return res.status(500).json({message: "server error", error: error.message})
}
}

