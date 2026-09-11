import re
from typing import Dict, Any
from backend.services.ai_qualifier import call_gemini
from backend.services.mail_service import get_lead_service_key, get_greeting_name
from backend.services.quote_engine import calculate_quote
from backend.services.payment_service import generate_payment_link
from backend.config import load_settings_dict

def process_buyer_message(lead: dict, incoming_text: str) -> Dict[str, Any]:
    settings = load_settings_dict()
    gemini_key = settings.get("geminiKey")

    service_key = get_lead_service_key(lead)
    
    # Detect quantity from incoming text if present
    qty_match = re.search(r'\b(\d{1,5})\s*(?:pcs|pieces|items|t[\s-]?shirts|designs|files|photos|images|nos)?\b', incoming_text, re.IGNORECASE)
    quantity = int(qty_match.group(1)) if qty_match else 50

    quote = calculate_quote(service_key, quantity)

    # Detect if payment link is requested
    wants_payment = bool(re.search(r'(pay|payment|link|checkout|order|buy|confirm)', incoming_text, re.IGNORECASE))
    
    payment_info = None
    if wants_payment:
        payment_info = generate_payment_link(
            lead_id=lead["id"],
            amount=quote["total_amount"],
            description=f"Payment for {quote['title']} ({quantity} {quote['unit']}s)",
            customer_phone=lead.get("phone", ""),
            customer_email=lead.get("email", "")
        )

    buyer_name = get_greeting_name(lead)

    if gemini_key:
        prompt = f"""You are Natasha, a professional and helpful sales executive for ODD INFOTECH. 
Draft a friendly, concise WhatsApp reply (max 4-5 sentences) to a customer based on the details below.

Customer Name: {buyer_name}
Customer Message: "{incoming_text}"
Service: {quote['title']}
Quantity: {quantity} {quote['unit']}(s)
Unit Rate: ₹{quote['unit_rate']} per {quote['unit']}
Total Calculated Amount: ₹{quote['total_amount']}
Payment Link URL: {payment_info['payment_url'] if payment_info else 'None'}

Instructions:
- Address the customer warmly by name.
- Provide the clear rate and total cost.
- Mention timeline (3-4 working days).
- If payment link URL is provided, include it nicely in the message.
- End with a clear call to action to confirm order.
- Do NOT use markdown bold headers like '###'. Use plain text or WhatsApp bold (*text*)."""

        try:
            ai_reply = call_gemini(gemini_key, prompt)
            return {
                "reply_text": ai_reply.strip(),
                "quote": quote,
                "payment_info": payment_info
            }
        except Exception as e:
            print(f"[AI Agent Error] Gemini fallback used: {e}")

    # Robust Fallback Template Response
    reply_lines = [
        f"Hi {buyer_name}! Thank you for reaching out to ODD INFOTECH.\n",
        f"For *{quote['title']}* ({quantity} {quote['unit']}s):",
        f"Rate: ₹{quote['unit_rate']}/{quote['unit']}",
        f"Total Amount: *₹{quote['total_amount']}*",
        f"Delivery Timeline: 3-4 working days.\n"
    ]

    if payment_info:
        reply_lines.append(f"You can proceed with payment using this link: {payment_info['payment_url']}\n")

    reply_lines.append("Would you like us to proceed with your order?")
    
    return {
        "reply_text": "\n".join(reply_lines),
        "quote": quote,
        "payment_info": payment_info
    }
