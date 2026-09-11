#!/usr/bin/env python3
"""Compact CI port of the Four Stars deterministic alignment scorer."""
import argparse, json, re, unicodedata, urllib.request
from html.parser import HTMLParser

WEIGHTS = {"title": 25, "meta": 25, "h1": 20, "first": 15, "h2": 15, "slug": 10}
CONNECTORS = {"a","an","the","in","of","for","to","at","on","near","and","with","by"}
CTA = {"get","find","book","compare","see","check","start","call","request","learn","save"}
PROOF = {"free","licensed","insured","trusted","rated","reviews","certified","same","day","24","7","fast"}
THROAT = ("when it comes to","in today's","in this article","whether you're","are you looking","if you're looking","have you ever","as a homeowner","let's face it","welcome to")


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[-/–—]", " ", s)
    return re.sub(r"[^\w\s]", " ", s)


def stem(t):
    if len(t) > 4 and t.endswith("ies"): return t[:-3] + "y"
    if len(t) > 3 and t.endswith("s") and not t.endswith("ss"): return t[:-1]
    return t


def toks(s): return [stem(x) for x in norm(s).split() if x]

def match(text, keyword):
    words, kw = toks(text), toks(keyword)
    if not kw: return (False, 0.0, -1)
    coverage = sum(1 for x in kw if x in words) / len(kw)
    for i, w in enumerate(words):
        if w != kw[0]: continue
        j, k = i + 1, 1
        while j < len(words) and k < len(kw):
            if words[j] == kw[k]: k += 1
            elif words[j] not in CONNECTORS: break
            j += 1
        if k == len(kw): return (True, 1.0, i)
    return (False, coverage, min((i for i,w in enumerate(words) if w in kw), default=-1))


def grade(total):
    return "A" if total >= 85 else "B" if total >= 70 else "C" if total >= 55 else "D" if total >= 40 else "F"


class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title=""; self.meta=""; self.h1=[]; self.h2=[]; self.paras=[]
        self.capture=None; self.buf=[]; self.seen_h1=False
    def handle_starttag(self, tag, attrs):
        if tag == "meta":
            a=dict(attrs); name=(a.get("name") or a.get("property") or "").lower()
            if name in ("description","og:description") and not self.meta: self.meta=a.get("content") or ""
        if tag in ("title","h1","h2","p"):
            self.capture=tag; self.buf=[]
    def handle_data(self, data):
        if self.capture: self.buf.append(data)
    def handle_endtag(self, tag):
        if tag != self.capture: return
        text=re.sub(r"\s+"," ","".join(self.buf)).strip(); self.capture=None
        if not text: return
        if tag=="title" and not self.title: self.title=text
        elif tag=="h1": self.h1.append(text); self.seen_h1=True
        elif tag=="h2": self.h2.append(text)
        elif tag=="p" and len(text.split())>=5: self.paras.append((text,self.seen_h1))
    def first(self):
        return next((t for t,after in self.paras if after), self.paras[0][0] if self.paras else "")

def fetch(url):
    req=urllib.request.Request(url, headers={"User-Agent":"FourStarsCI/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", errors="replace")


def score(url, keyword):
    p=Parser(); p.feed(fetch(url)); p.close()
    total=0.0; detail={}
    exact,cov,pos=match(p.title,keyword)
    s=(12 if exact else 7 if cov==1 else 3 if cov>0 else 0) + (6 if exact and pos<=4 else 2 if cov>0 else 0) + (7 if 30<=len(p.title)<=60 else 4 if p.title else 0)
    detail["title"]=s; total+=s
    exact,cov,pos=match(p.meta,keyword); words=set(toks(p.meta))
    s=(12 if exact else 5 if cov==1 else 2 if cov>0 else 0) + (6 if 120<=len(p.meta)<=160 else 3 if p.meta else 0) + (7 if words&CTA and (words&PROOF or re.search(r"\d",p.meta)) else 4 if words&CTA or words&PROOF else 0)
    detail["meta"]=s; total+=s
    h=p.h1[0] if p.h1 else ""; exact,cov,_=match(h,keyword)
    s=(5 if len(p.h1)==1 else 1 if p.h1 else 0) + (10 if exact else 6 if cov==1 else 3 if cov>0 else 0) + (5 if match(p.title,keyword)[0] and exact else 3 if cov>0 else 0)
    detail["h1"]=s; total+=s
    f=p.first(); exact,cov,pos=match(f,keyword); direct=not norm(f).startswith(THROAT)
    s=(8 if exact and pos<=25 else 4 if exact else 3 if cov==1 else 0) + (7 if direct and f else 0)
    detail["first"]=s; total+=s
    anchored=sum(1 for h2 in p.h2 if match(h2,keyword)[1]>0)
    ratio=anchored/len(p.h2) if p.h2 else 0
    vague=sum(1 for h2 in p.h2 if match(h2,keyword)[1]==0 and len(h2.split())<=6 and not re.search(r"\d",h2))
    s=(8 if ratio>=.4 else round(8*(ratio/.4),1) if p.h2 else 0) + (7 if p.h2 and vague==0 else max(0,round(7*(1-(vague/len(p.h2))*2),1)) if p.h2 else 0)
    detail["h2"]=s; total+=s
    slug=url.rstrip("/").split("/")[-1].replace("-"," ").replace("_"," ")
    exact,cov,_=match(slug,keyword); n=len(toks(slug))
    s=(7 if exact else 4 if cov==1 else round(7*cov*.3,1)) + (3 if n<=6 else 2 if n<=9 else 1)
    detail["slug"]=s; total+=s
    total=round(100*total/110,1)
    return {"url":url,"keyword":keyword,"total":total,"grade":grade(total),"elements":detail}


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--url",required=True); ap.add_argument("--keyword",required=True); ap.add_argument("--json",action="store_true")
    a=ap.parse_args(); r=score(a.url,a.keyword)
    if a.json: print(json.dumps(r))
    else: print(json.dumps(r,indent=2))


if __name__=="__main__": main()
