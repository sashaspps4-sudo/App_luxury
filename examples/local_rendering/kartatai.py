"""KARTATAI adapter. Receives the saved config and listing from the worker."""
import json
import re
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse
import requests

KARTATAI_TIMEOUT = 60


def normalize_amount(value):
    text = re.sub(r'[^0-9,.+-]', '', str(value or ''))
    if ',' in text and '.' in text:
        text = text.replace(',', '') if text.rfind('.') > text.rfind(',') else text.replace('.', '').replace(',', '.')
    else:
        text = text.replace(',', '.')
    try:
        amount = Decimal(text)
        if not amount.is_finite() or amount < 0:
            raise ValueError()
        return format(amount.quantize(Decimal('0.01')), 'f')
    except (InvalidOperation, ValueError) as exc:
        raise ValueError('LINK_PROVIDER_INVALID_PRICE') from exc


def listing_fields(settings, ad):
    verify = settings.get('mode') in ('verif', 'verify')
    seller = ad.get('name') or ad.get('seller') or ''
    if isinstance(seller, dict):
        seller_data = seller
        seller = seller.get('name') or seller.get('username') or ''
    else:
        seller_data = ad.get('seller') if isinstance(ad.get('seller'), dict) else {}
    title = str(seller if verify else ad.get('title') or '').strip()
    if not title:
        raise ValueError('KARTATAI_SELLER_NAME_REQUIRED' if verify else 'KARTATAI_TITLE_REQUIRED')
    photo = (ad.get('avatar_url') or seller_data.get('avatar_url') or seller_data.get('avatar')) if verify else ad.get('image_url')
    raw_price = ad.get('price')
    price = None
    if raw_price is not None and str(raw_price).strip():
        currency = str(ad.get('currency') or '').strip().upper()
        if not currency:
            match = re.search(r'\b(USD|AUD|CAD|EUR|GBP|SGD|MYR|PLN|CZK|DKK|SEK|RON)\b', str(raw_price), re.I)
            currency = match[1].upper() if match else ''
        if not currency:
            if '€' in str(raw_price): currency = 'EUR'
            elif '£' in str(raw_price): currency = 'GBP'
        if not currency:
            geos = settings.get('selectedGeos') or []
            geo = str(ad.get('geo') or (geos[0] if len(geos) == 1 else '')).upper()
            currency = {'US':'USD','USA':'USD','AU':'AUD','CA':'CAD','GB':'GBP','UK':'GBP','SG':'SGD','MY':'MYR','PL':'PLN','CZ':'CZK','DK':'DKK','SE':'SEK','RO':'RON'}.get(geo)
            if not currency and geo in ('AT','BE','DE','ES','FR','GR','IT','LT','NL','PT'):
                currency = 'EUR'
        if not currency:
            raise ValueError('KARTATAI_CURRENCY_REQUIRED')
        price = normalize_amount(raw_price) + ' ' + currency
    elif not verify:
        raise ValueError('LINK_PROVIDER_INVALID_PRICE')
    return {'title': title, 'photo': photo or None, 'price': price}


def response_value_at_path(data, path):
    for key in path.split('.'):
        if isinstance(data, dict):
            data = data.get(key)
        elif isinstance(data, list) and key.isdigit() and int(key) < len(data):
            data = data[int(key)]
        else:
            return None
    return data


def kartatai_category(settings, ad):
    platform = settings.get('serviceCode')
    mode = settings.get('mode', '2.0')
    geos = settings.get('selectedGeos') or []
    geo = str(ad.get('geo') or (geos[0] if len(geos) == 1 else '')).upper()
    geo = {'GB': 'UK', 'USA': 'US'}.get(geo, geo)
    verify = mode in ('verif', 'verify')
    fixed = {
        '2dehands': ('2dehands_be', None),
        'Poshmark': ('poshmark_eu', 'poshmark3_eu'),
        'Etsy': ('etsy_uk', 'etsy_eu'),
        'Marktplaats': ('marktplaats_nl', 'marktplaats3_nl'),
        'Kijiji': (None, 'kijijiVerif_ca'),
        'Fiverr': ('fiverr2_eu', 'fiverr_eu'),
        'Kleinanzeigen': ('ebay_de', 'kleinanzeigen3_de'),
        'Leboncoin': ('leboncoin_fr', 'leboncoin3_fr'),
        'Subito': ('subito_it', 'subito3_it'),
        'OfferUp': ('offerup2_usa', 'offerup3_usa'),
    }
    if platform in fixed:
        category = fixed[platform][int(verify)]
    elif platform == 'Vinted':
        category = 'vinted_eu' if verify else ('vinted_' + geo.lower() if geo else None)
    elif platform == 'Depop':
        category = 'depop3_usa' if verify else 'depop_eu'
    elif platform == 'Carousell':
        category = 'carousell' + ('3' if verify else '2') + '_' + geo.lower() if geo in ('SG', 'MY') else None
    elif platform == 'Wallapop':
        category = ('wallapop_verif_es' if verify else 'wallapop_es') if geo == 'ES' else ('wallapop_it' if geo == 'IT' and not verify else None)
    elif platform == 'Gumtree':
        category = ('gumtreeverif_' if verify else 'gumtree_') + geo.lower() if geo in ('AU', 'UK') else None
    else:
        category = None
    if not category:
        raise ValueError('KARTATAI_UNSUPPORTED_CATEGORY_OR_AMBIGUOUS_GEO')
    return category


def generate_link(settings: dict, ad: dict) -> str:
    user_id = str(settings.get('userId') or settings.get('kartataiUserId') or '').strip()
    api_key = str(settings.get('apiKey') or settings.get('kartataiApiKey') or '').strip()
    if not user_id:
        raise ValueError('LINK_PROVIDER_CREDENTIAL_REQUIRED')
    if not api_key:
        raise ValueError('KARTATAI_API_KEY_REQUIRED')
    endpoint = str(settings.get('endpoint') or settings.get('kartataiEndpoint') or '').strip()
    if not endpoint:
        raise ValueError('LINK_PROVIDER_ENDPOINT_NOT_CONFIGURED')
    if urlparse(endpoint).scheme not in ('http', 'https') or not urlparse(endpoint).hostname:
        raise ValueError('LINK_PROVIDER_INVALID_ENDPOINT')
    service = kartatai_category(settings, ad)
    payload = {
        'api_key': api_key, **listing_fields(settings, ad),
        'name': str(settings.get('buyerName') or '').strip(),
        'address': str(settings.get('buyerAddress') or '').strip() or None,
        'service': service, 'userId': user_id or None,
    }
    values = {
        'USER_KARTATAI_API_KEY': api_key, 'USER_KARTATAI_TELEGRAM_ID': user_id,
        **{'ad.' + key: value for key, value in ad.items()},
        'ad.price': payload['price'], 'preset.buyerName': payload['name'],
        'preset.buyerAddress': payload['address'] or '',
    }
    def substitute(value):
        if isinstance(value, str):
            return re.sub(r'\{\{?([\w.]+)\}\}?', lambda m: str(values.get(m[1], m[0])), value)
        if isinstance(value, dict):
            return {k: substitute(v) for k, v in value.items()}
        if isinstance(value, list):
            return [substitute(v) for v in value]
        return value
    if settings.get('requestBody', '').strip():
        custom = substitute(json.loads(settings['requestBody']))
        if not isinstance(custom, dict):
            raise ValueError('LINK_PROVIDER_INVALID_REQUEST_BODY')
        payload.update(custom)
    payload['service'] = service
    try:
        with requests.Session() as client:
            client.trust_env = False
            response = client.post(
                endpoint,
                json={k: v for k, v in payload.items() if v is not None},
                headers={'Content-Type': 'application/json; charset=UTF-8'},
                timeout=KARTATAI_TIMEOUT,
                allow_redirects=False,
            )
            response.raise_for_status()
            result = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise ValueError('LINK_PROVIDER_REQUEST_FAILED') from exc
    if not isinstance(result, dict) or result.get('status') is False:
        raise ValueError('LINK_PROVIDER_CREATE_FAILED')
    for path in (settings.get('responsePath') or 'message', 'result.link', 'result.short', 'link', 'short', 'message'):
        link = response_value_at_path(result, path)
        if isinstance(link, str) and urlparse(link).scheme in ('http', 'https') and urlparse(link).hostname:
            return link
    raise ValueError('LINK_PROVIDER_INVALID_RESPONSE')
