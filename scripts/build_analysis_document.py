"""Build the Vietnamese analysis report from repository Markdown and rendered UML.

Run with the Codex bundled Python (reportlab, pypdf, Pillow). No application DB
or user data is read. PlantUML diagrams must already have PNG and SVG renders.
"""
from pathlib import Path
import re
import html
import base64
import json
from xml.sax.saxutils import escape

from PIL import Image as PillowImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak,
    NextPageTemplate, Image, LongTable, TableStyle, KeepTogether,
)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'docs' / 'analysis'
OUT = BASE / 'output'
OUT.mkdir(exist_ok=True)
TITLE = 'Phân tích nghiệp vụ và thiết kế hệ thống'
SUBTITLE = 'Nhận diện biển số độ phân giải thấp'
DATE = '24/10/2026'


def chapters():
    result = {}
    extras = []
    for filename in ['01-nghiep-vu.md', '02-luong-va-kien-truc.md', '03-tuong-tac-api.md', '04-thiet-ke-db.md']:
        text = (BASE / filename).read_text(encoding='utf-8-sig').replace('\u2014', '-').replace('\u2013', '-').replace('\u2011', '-')
        if filename == '04-thiet-ke-db.md':
            text = '\n'.join('#' + line if line.startswith('#') else line for line in text.splitlines())
        parts = re.split(r'(?m)^(##\s+(\d+)[ .][^\n]*)\n', text)
        for i in range(1, len(parts), 3):
            heading, number, body = parts[i:i+3]
            if filename == '01-nghiep-vu.md' and int(number) >= 7:
                extras.append((int(number), body))
                continue
            number = int(number)
            if number in result:
                raise ValueError(f'Duplicate chapter {number} in {filename}')
            result[number] = heading + '\n\n' + body.strip()
    if set(result) != set(range(1,15)):
        raise ValueError(f'Expected chapters 1..14, got {sorted(result)}')
    for number, body in extras:
        if number == 7:
            result[13] += '\n\n### 13.5 Ma trận nghiệm thu nghiệp vụ\n\n' + body.strip()
    if 'diagrams/01-use-case.' not in result[6]:
        result[6] = result[6].replace('\n\n', '\n\n![Use case tổng thể](diagrams/01-use-case.png)\n\n', 1)
    return result


def inline(text, pdf=True):
    # Links remain readable even if the reader is viewing a detached PDF.
    text = escape(text.strip())
    text = re.sub(r'`([^`]+)`', r'<font name="Arial">\1</font>' if pdf else r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'(?<!\*)\*([^*]+)\*', r'<i>\1</i>', text)
    def link(match):
        label, target = match.groups()
        if pdf:
            if target.startswith(('https://', 'http://')):
                return f'<a href="{target}" color="#234E70">{label}</a>'
            return label
        return f'<a href="{target}">{label}</a>'
    return re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, text)


def blocks(markdown):
    lines = markdown.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith('```'):
            language = line[3:]
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i]); i += 1
            yield ('code', '\n'.join(code), language)
            i += 1
            continue
        picture = re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)', line)
        if picture:
            yield ('figure', picture.group(1), picture.group(2))
            i += 1; continue
        heading = re.match(r'^(#{1,6})\s+(.*)', line)
        if heading:
            yield ('heading', heading.group(2), len(heading.group(1)))
            i += 1; continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                row = re.split(r'(?<!\\)\|', lines[i].strip().strip('|'))
                row = [v.strip().replace('\\|', '|') for v in row]
                if not all(re.fullmatch(r':?-+:?', v) for v in row):
                    rows.append(row)
                i += 1
            if len({len(row) for row in rows}) != 1:
                raise ValueError(f'Broken Markdown table: {rows[:2]}')
            yield ('table', rows, None)
            continue
        bullet = re.match(r'^(?:[-*]|\d+[.)])\s+(.*)', line)
        if bullet:
            yield ('bullet', bullet.group(1), None)
            i += 1; continue
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#|\||!\[|```|[-*] |\d+[.)] )', lines[i].strip()):
            paragraph.append(lines[i].strip()); i += 1
        yield ('paragraph', ' '.join(paragraph), None)


def generate():
    content = chapters()
    compiled = f'# {TITLE}\n\n{SUBTITLE}\n\nPhiên bản 1.1 · {DATE}\n\n'
    compiled += '\n\n'.join(content[k] for k in sorted(content)) + '\n'
    (BASE / 'PHAN_TICH_NGHIEP_VU_VA_THIET_KE.md').write_text(compiled, encoding='utf-8')
    for name, filename in [('Arial','arial.ttf'),('Arial-Bold','arialbd.ttf'),('Arial-Italic','ariali.ttf'),('Arial-BoldItalic','arialbi.ttf')]:
        pdfmetrics.registerFont(TTFont(name, str(Path('C:/Windows/Fonts') / filename)))
    pdfmetrics.registerFontFamily('Arial',normal='Arial',bold='Arial-Bold',italic='Arial-Italic',boldItalic='Arial-BoldItalic')
    styles = {
        'body': ParagraphStyle('body',fontName='Arial',fontSize=10.2,leading=14.5,spaceAfter=6,splitLongWords=True),
        'h1': ParagraphStyle('h1',fontName='Arial-Bold',fontSize=17,leading=22,spaceBefore=10,spaceAfter=12,keepWithNext=True),
        'h2': ParagraphStyle('h2',fontName='Arial-Bold',fontSize=12.4,leading=17,spaceBefore=12,spaceAfter=7,keepWithNext=True),
        'h3': ParagraphStyle('h3',fontName='Arial-Bold',fontSize=10.8,leading=15,spaceBefore=9,spaceAfter=5,keepWithNext=True),
        'cell': ParagraphStyle('cell',fontName='Arial',fontSize=8.8,leading=12,spaceAfter=0,splitLongWords=True),
        'small': ParagraphStyle('small',fontName='Arial',fontSize=8,leading=11,spaceAfter=5),
        'bullet': ParagraphStyle('bullet',fontName='Arial',fontSize=10.2,leading=14.5,spaceAfter=5,leftIndent=11,firstLineIndent=-8),
        'code': ParagraphStyle('code',fontName='Arial',fontSize=8.5,leading=12,spaceAfter=9,leftIndent=12,backColor=colors.HexColor('#F4F6F8')),
    }
    W,H=A4
    margin=44
    available=W-2*margin
    toc=TableOfContents()
    toc.levelStyles=[ParagraphStyle('toc',fontName='Arial',fontSize=10.5,leading=17,spaceBefore=4,leftIndent=0,rightIndent=20)]
    class Report(BaseDocTemplate):
        def afterFlowable(self, flowable):
            if isinstance(flowable,Paragraph) and getattr(flowable,'is_chapter',False):
                self.notify('TOCEntry',(0,flowable.getPlainText(),self.page,flowable.bookmark))
                self.canv.bookmarkPage(flowable.bookmark)
                self.canv.addOutlineEntry(flowable.getPlainText(),flowable.bookmark,0)
    def footer(canvas, doc):
        width,height=canvas._pagesize
        canvas.setFont('Arial',8)
        canvas.setFillColor(colors.HexColor('#555555'))
        if doc.page > 1:
            canvas.drawString(margin,24,'LR LPR | Phân tích nghiệp vụ và thiết kế | 1.1')
            canvas.drawRightString(width-margin,24,str(doc.page))
    pdf=OUT/'PHAN_TICH_NGHIEP_VU_VA_THIET_KE.pdf'
    doc=Report(str(pdf),pagesize=A4,title=TITLE+' '+SUBTITLE,author='Tài liệu dự án Low-resolution License Plate Recognition')
    templates=[]
    for name,size in [('portrait',A4),('landscape',landscape(A4))]:
        w,h=size
        templates.append(PageTemplate(id=name,pagesize=size,frames=[Frame(margin,40,w-2*margin,h-82,leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)],onPage=footer))
    doc.addPageTemplates(templates)
    story=[Spacer(1,55),Paragraph(TITLE,ParagraphStyle('cover',fontName='Arial-Bold',fontSize=23,leading=31,spaceAfter=18)),Paragraph(SUBTITLE,ParagraphStyle('sub',fontName='Arial',fontSize=19,leading=26,spaceAfter=34))]
    story.extend([Paragraph('Tài liệu nghiệp vụ và thiết kế kỹ thuật',styles['h2']),Paragraph(f'Phiên bản 1.1 | Ngày hoàn thiện {DATE}',styles['body']),Paragraph('Dành cho nhóm phát triển, người kiểm thử và người đánh giá đồ án.',styles['body']),Spacer(1,20),Paragraph('Phạm vi',styles['h2']),Paragraph('Ứng dụng nhận diện, kiểm duyệt và tra cứu biển số từ ảnh/video tải lên. Backend NestJS, PostgreSQL và worker Node điều phối inference Python. Tài liệu bao gồm yêu cầu, use case, activity, sequence, mô hình trạng thái, API, kiến trúc và từ điển dữ liệu.',styles['body']),Paragraph('Hiện trạng',styles['h2']),Paragraph('Pipeline theo notebook PBL6: sampling, gate, YOLO11l, BoT-SORT, OCR SE-ResNet34-C nhận đồng thời năm crop từ video, decoder beam_filter. Ảnh đơn có detection/crop và nhập thủ công; OCR ảnh đơn cần model riêng. Một job thành công không chứng minh biển số được đọc đúng.',styles['body']),PageBreak(),Paragraph('Mục lục',styles['h1']),toc,PageBreak()])
    html_parts=[f'<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{TITLE}</title><style>body{{font:16px/1.65 Arial,sans-serif;color:#17212b;max-width:1120px;margin:auto;padding:36px;background:white}}h1,h2,h3,h4{{color:#000;line-height:1.3}}h2{{margin-top:56px}}table{{border-collapse:collapse;width:100%;margin:18px 0;font-size:14px}}td,th{{border:1px solid #d9d9d9;padding:9px;vertical-align:top}}th{{background:#234e70;color:white;text-align:left}}tr:nth-child(even){{background:#f5f7f8}}code,pre{{font:13px/1.5 Consolas,monospace}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:18px}}figure{{margin:30px 0;border:1px solid #ddd;padding:18px;break-inside:avoid}}figure img{{display:block;width:100%;max-height:1100px;object-fit:contain}}figcaption{{font-weight:bold;margin-top:15px}}a{{color:#225878}}nav a{{display:block}}@media print{{body{{max-width:none;padding:0}}figure{{break-before:page}}}}</style><h1>{TITLE}</h1><p>{SUBTITLE} · 1.1 · {DATE}</p><nav>']
    for n, chapter in content.items():
        heading=chapter.splitlines()[0].lstrip('# ')
        html_parts.append(f'<a href="#chapter{n}">{html.escape(heading)}</a>')
    html_parts.append('</nav>')
    figure_index=0
    figure_info=[]
    for number in sorted(content):
        chapter_figures=[]
        for kind,value,other in blocks(content[number]):
            if kind=='heading':
                level=other
                style=styles['h1' if level==2 else 'h2' if level==3 else 'h3']
                if level==2:
                    if number!=1 and not isinstance(story[-1],PageBreak): story.append(PageBreak())
                    p=Paragraph(inline(value),style);p.is_chapter=True;p.bookmark=f'chapter{number}'
                    story.append(p)
                    html_parts.append(f'<h2 id="chapter{number}">{inline(value,False)}</h2>')
                else:
                    if number==7 and value.startswith('7.3 '): story.append(PageBreak())
                    if number==14 and value.startswith('14.2.'): story.append(PageBreak())
                    story.append(Paragraph(inline(value),style))
                    html_parts.append(f'<h{min(level,5)}>{inline(value,False)}</h{min(level,5)}>')
            elif kind=='figure':
                figure_index+=1
                source=BASE/other
                png=source.with_suffix('.png');svg=source.with_suffix('.svg')
                if not png.is_file() or not svg.is_file():raise FileNotFoundError(source)
                if 'Syntax Error' in svg.read_text(encoding='utf-8'):
                    raise ValueError(f'PlantUML did not render successfully: {source.stem}')
                iw,ih=PillowImage.open(png).size
                candidates=[]
                for mode,size in [('portrait',A4),('landscape',landscape(A4))]:
                    aw,ah=size[0]-2*margin,size[1]-180
                    candidates.append((min(aw/iw,ah/ih),mode))
                scale,mode=max(candidates)
                story.append(Paragraph(f'Xem Sơ đồ {figure_index}: {inline(value)} ở cuối chương này.',styles['small']))
                chapter_figures.append((mode,figure_index,value,png,iw*scale,ih*scale,source.stem))
                encoded=base64.b64encode(svg.read_bytes()).decode('ascii')
                html_parts.append(f'<figure><img alt="{html.escape(value)}" src="data:image/svg+xml;base64,{encoded}"><figcaption>Sơ đồ {figure_index} {html.escape(value)}</figcaption></figure>')
                figure_info.append({'number':figure_index,'source':source.stem,'title':value,'orientation':mode,'render_size': [iw,ih]})
            elif kind=='table':
                cols=len(value[0])
                headers=' '.join(value[0]).lower()
                if cols==4 and ('postgresql' in headers or ('kiểu' in headers and 'null' in headers)):
                    ratios=[.25,.20,.08,.47]
                elif cols==5:ratios=[.09,.25,.24,.21,.21]
                elif cols==4 and ('truy vết' in headers or 'truy vet' in headers):ratios=[.09,.31,.41,.19]
                elif cols==4 and 'chưa đăng nhập' in headers:ratios=[.37,.21,.21,.21]
                elif cols==4:ratios=[.22,.27,.28,.23]
                elif cols==3 and 'use case' in headers:ratios=[.10,.74,.16]
                elif cols==3 and headers.startswith('mã'):ratios=[.12,.38,.50]
                elif cols==3:ratios=[.22,.30,.48]
                elif cols==2:ratios=[.28,.72]
                else:ratios=[1/cols]*cols
                if cols==2 and value[0][0].lower()=='mã':ratios=[.12,.88]
                header_style=ParagraphStyle('thead',parent=styles['cell'],fontName='Arial-Bold',textColor=colors.white)
                rows=[[Paragraph(inline(cell),header_style if i==0 else styles['cell']) for cell in row] for i,row in enumerate(value)]
                table=LongTable(rows,colWidths=[available*r for r in ratios],repeatRows=1,hAlign='LEFT')
                table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#234E70')),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F5F7F8')]),('GRID',(0,0),(-1,-1),.4,colors.HexColor('#D9D9D9')),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
                story.extend([table,Spacer(1,10)])
                html_parts.append('<table>'+''.join('<tr>'+''.join(f'<{"th" if i==0 else "td"}>{inline(cell,False)}</{"th" if i==0 else "td"}>' for cell in row)+'</tr>' for i,row in enumerate(value))+'</table>')
            elif kind=='code':
                escaped=escape(value).replace(' ','&#160;').replace('\n','<br/>')
                story.append(Paragraph(escaped,styles['code']))
                html_parts.append('<pre>'+html.escape(value)+'</pre>')
            elif kind=='bullet':
                story.append(Paragraph('• '+inline(value),styles['bullet']))
                html_parts.append('<p>• '+inline(value,False)+'</p>')
            else:
                story.append(Paragraph(inline(value),styles['body']))
                html_parts.append('<p>'+inline(value,False)+'</p>')
        for mode,index,title,png,iw,ih,stem in chapter_figures:
            story.extend([NextPageTemplate(mode),PageBreak(),Paragraph(f'Sơ đồ {index} {inline(title)}',styles['h2']),Image(str(png),width=iw,height=ih),Spacer(1,8),Paragraph(f'Nguồn chỉnh sửa: diagrams/{stem}.puml',styles['small'])])
        if chapter_figures:
            story.extend([NextPageTemplate('portrait'),PageBreak()])
    doc.multiBuild(story)
    html_parts.append('</html>')
    # Output stays under analysis so source links in each chapter remain valid.
    (BASE/'PHAN_TICH_NGHIEP_VU_VA_THIET_KE.html').write_text('\n'.join(html_parts),encoding='utf-8')
    (OUT/'figures.json').write_text(json.dumps(figure_info,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'pdf':str(pdf),'figures':figure_index,'chapters':len(content)},ensure_ascii=False))


if __name__=='__main__':
    generate()
