from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether

OUT = "output/pdf/callscore-internal-review-manual.pdf"
INK = HexColor("#07090B")
PANEL = HexColor("#101419")
LINE = HexColor("#26313C")
MUTED = HexColor("#98A4B3")
AQUA = HexColor("#12E8E0")
WHITE = HexColor("#F7F9FB")
AMBER = HexColor("#E9D495")

doc = SimpleDocTemplate(OUT, pagesize=A4, rightMargin=17 * mm, leftMargin=17 * mm, topMargin=15 * mm, bottomMargin=14 * mm)
styles = {
    "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=24, leading=27, textColor=WHITE, spaceAfter=4),
    "sub": ParagraphStyle("sub", fontName="Helvetica", fontSize=9.5, leading=13, textColor=MUTED, spaceAfter=13),
    "h": ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=10.5, leading=13, textColor=AQUA, spaceBefore=9, spaceAfter=4),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=8.8, leading=12, textColor=WHITE),
    "small": ParagraphStyle("small", fontName="Helvetica", fontSize=8.1, leading=10.6, textColor=MUTED),
    "note": ParagraphStyle("note", fontName="Helvetica", fontSize=8.5, leading=11.5, textColor=AMBER),
}

def p(text, style="body"):
    return Paragraph(text, styles[style])

story = [
    Spacer(1, 1 * mm),
    p("CallScore", "title"),
    p("Internal review manual - a short guide for testing audio-call scoring", "sub"),
]

quick = Table([[p("<b>1. Configure</b><br/>Open Settings. Scribe v2 is the recommended high-quality default. Fish Transcribe 1 Pro is useful for testing native speaker labels. Save your model choices.", "body"),
                p("<b>2. Analyze</b><br/>Upload a call recording (up to 25 MB) or paste a transcript. Add the rep name if known, then choose Analyze call.", "body")]], colWidths=[86 * mm, 86 * mm])
quick.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), PANEL), ("BOX", (0, 0), (-1, -1), 0.7, LINE),
    ("INNERGRID", (0, 0), (-1, -1), 0.7, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
]))
story += [quick, Spacer(1, 5 * mm), p("What happens during analysis", "h")]

workflow_rows = [
    [p("Prepare", "body"), p("Reads the audio. With Scribe v2, the original audio is used to avoid slow browser re-encoding on long calls.", "small")],
    [p("Transcribe", "body"), p("Speech becomes text. Scribe, Fish and MAI Transcribe 2 can provide speaker markers.", "small")],
    [p("Tanglish + speakers", "body"), p("Tamil script is converted to readable Tanglish. Anonymous speaker markers are mapped to Rep or Customer.", "small")],
    [p("Score", "body"), p("The analysis model reviews the full call against the sales rubric and creates coaching, objections and evidence.", "small")],
    [p("Validate", "body"), p("Every cited quote is checked against the transcript and against the claimed speaker before it can affect the result.", "small")],
]
workflow = Table(workflow_rows, colWidths=[41 * mm, 131 * mm])
workflow.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), PANEL), ("BOX", (0, 0), (-1, -1), 0.7, LINE),
    ("INNERGRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("TEXTCOLOR", (0, 0), (0, -1), AQUA), ("LEFTPADDING", (0, 0), (-1, -1), 9),
    ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story += [workflow, Spacer(1, 5 * mm), p("How scoring works", "h")]

score_text = "CallScore scores eight areas: opening and rapport, lead context, discovery, active listening, solution fit, objection handling, closing, and compliance. Each area is rated from 0 to 3. The final result uses only verified, applicable evidence; it is not a simple summary generated from the transcript."
story += [p(score_text), Spacer(1, 3 * mm)]

review = Table([[p("<b>About Review notes</b><br/>A note means a quote was removed because it was not found in the transcript or was attributed to the wrong speaker. This is a safety feature: removed evidence does not affect the score. A few notes can happen; repeated notes across categories mean the result needs human review.", "note")]], colWidths=[172 * mm])
review.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), HexColor("#211C10")), ("BOX", (0, 0), (-1, -1), 0.7, HexColor("#725D2D")),
    ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story += [review, Spacer(1, 5 * mm), p("Internal tester checklist", "h")]

checklist = [
    "Check the Transcript tab first: are the words understandable and are Rep and Customer correct?",
    "If the roles are reversed, choose <b>Swap roles and re-score</b>. It reuses the transcript and does not transcribe the audio again.",
    "Use Review notes to identify unsupported quotes. Do not treat a score with many removed quotes as final coaching.",
    "Record the model used, call length, timings, and trace ID when reporting a slow or failed run.",
]
for item in checklist:
    story.append(p(f'<font color="#12E8E0">&#8226;</font> {item}', "body"))
    story.append(Spacer(1, 1.2 * mm))

story += [Spacer(1, 4 * mm), p("Internal test build - scores are decision support, not a replacement for manager review.", "small")]

def page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(INK)
    canvas.rect(0, 0, A4[0], A4[1], fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.line(17 * mm, 10 * mm, A4[0] - 17 * mm, 10 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(17 * mm, 6.5 * mm, "CallScore - Internal review")
    canvas.drawRightString(A4[0] - 17 * mm, 6.5 * mm, f"Page {doc.page}")
    canvas.restoreState()

doc.build(story, onFirstPage=page, onLaterPages=page)
