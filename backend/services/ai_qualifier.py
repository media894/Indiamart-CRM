import json
import re
import requests
from typing import Dict, Any

GEMINI_MODELS = [
    {"id": "gemini-2.0-flash-lite", "api": "v1beta"},
    {"id": "gemini-2.0-flash", "api": "v1beta"},
    {"id": "gemini-1.5-flash-latest", "api": "v1beta"},
    {"id": "gemini-1.5-flash-8b-latest", "api": "v1beta"},
    {"id": "gemini-1.5-pro-latest", "api": "v1beta"},
]

def call_gemini(api_key: str, prompt: str) -> str:
    last_quota_msg = None
    for model in GEMINI_MODELS:
        m_id = model["id"]
        api_ver = model["api"]
        try:
            url = f"https://generativelanguage.googleapis.com/{api_ver}/models/{m_id}:generateContent?key={api_key}"
            payload = {"contents": [{"parts": [{"text": prompt}]}]}
            res = requests.post(url, json=payload, timeout=20)
            data = res.json()

            if "error" in data:
                code = data["error"].get("code", 0)
                msg = data["error"].get("message", "")
                if code == 404 or "not found" in msg.lower() or "not supported" in msg.lower():
                    continue
                if code == 429 or "quota" in msg.lower() or "resource_exhausted" in msg.lower() or "rate" in msg.lower():
                    last_quota_msg = msg
                    continue
                raise Exception(f"Gemini API error: {msg}")

            if "candidates" in data and len(data["candidates"]) > 0:
                parts = data["candidates"][0]["content"]["parts"]
                if parts and "text" in parts[0]:
                    return parts[0]["text"]
        except Exception as e:
            if "quota" in str(e).lower() or "resource_exhausted" in str(e).lower() or "rate" in str(e).lower():
                last_quota_msg = str(e)
                continue
            raise e

    raise Exception("All Gemini models exhausted. Please check quota or update API key.")

def build_fallback_qualification(lead: dict, reason: str = "Gemini unavailable") -> Dict[str, Any]:
    text = " ".join(filter(None, [
        lead.get("name"),
        lead.get("company"),
        lead.get("city"),
        lead.get("state"),
        lead.get("product"),
        lead.get("message"),
        lead.get("phone"),
        lead.get("email"),
        lead.get("source")
    ])).lower()

    score = 35
    strengths = []
    risks = []

    if lead.get("emailValid"):
        score += 12
        strengths.append("Valid business email")
    else:
        risks.append("Email validity is unknown or failed")

    if lead.get("phoneValid"):
        score += 15
        strengths.append("Reachable phone number")
    elif lead.get("phone"):
        score += 5
        risks.append("Phone number needs manual verification")
    else:
        risks.append("Phone number is missing")

    if lead.get("product") or lead.get("message"):
        score += 12
        strengths.append("Specific service requirement is present")
    else:
        risks.append("Requirement details are limited")

    if lead.get("company"):
        score += 8
        strengths.append("Company name is available")
    if lead.get("city") or lead.get("state"):
        score += 5
        strengths.append("Location is available")

    if re.search(r'(urgent|immediate|quotation|quote|price|cost|bulk|requirement|needed|design|package|vector|photo|editing|logo|brochure|catalogue)', text, re.IGNORECASE):
        score += 12
        strengths.append("Enquiry language suggests active buying interest")

    if re.search(r'(student|job|career|free|internship|spam|wrong number)', text, re.IGNORECASE):
        score -= 20
        risks.append("Lead text contains low-fit keywords")

    score = max(0, min(100, round(score)))
    status = "Hot" if score >= 70 else ("Warm" if score >= 45 else "Cold")
    first_name = (lead.get("name") or "there").split(" ")[0]
    product = lead.get("product") or "your enquiry"
    contact = "call" if lead.get("phone") else "email"

    return {
        "score": score,
        "status": status,
        "summary": f"{lead.get('name') or 'This lead'} looks {status.lower()} based on contact quality, requirement detail, and buying signals.",
        "strengths": strengths[:4] if strengths else ["Basic lead details are available"],
        "risks": risks[:4] if risks else ["No major risk signals found by the fallback scorer"],
        "next_action": f"Follow up by {contact} and confirm scope, quantity, budget, and timeline.",
        "suggested_subject": f"Regarding {product} | ODD INFOTECH",
        "suggested_body": f"Hi {first_name},\n\nThank you for your enquiry about {product}.\nCould you please share your requirement details, expected timeline, and budget range?\nWe can then suggest the best next step.\n\nBest regards",
        "fallback": True
    }

def qualify_lead(lead: dict, gemini_key: str) -> Dict[str, Any]:
    if not gemini_key:
        return build_fallback_qualification(lead, "Gemini API key is not configured")

    prompt = f"""You are a B2B lead qualification expert for an Indian business. Analyse and return ONLY valid JSON, no markdown.

Lead:
Name: {lead.get('name', '')}
Company: {lead.get('company', '')}
City: {lead.get('city', '')}, {lead.get('state', '')}
Product enquired: {lead.get('product', '')}
Message: {lead.get('message', '')}
Phone: {lead.get('phone', '')}
Email: {lead.get('email', '')}
Source: {lead.get('source', '')}

Return:
{{
  "score": <0-100>,
  "status": "<Hot|Warm|Cold>",
  "summary": "<2 sentence summary>",
  "strengths": ["...","..."],
  "risks": ["...","..."],
  "next_action": "<specific step>",
  "suggested_subject": "<email subject line>",
  "suggested_body": "<short professional email body in English, 4-5 lines>"
}}"""

    try:
        raw_text = call_gemini(gemini_key, prompt)
        clean_json = re.sub(r'```json|```', '', raw_text).strip()
        return json.loads(clean_json)
    except Exception as e:
        print(f"[AI Qualify Error] {e}")
        return build_fallback_qualification(lead, str(e))
