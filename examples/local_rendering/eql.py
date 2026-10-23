

import re
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
import requests

EQL_ENDPOINT = 'https://haronrent.xyz/api/v1/createAd'
EQL_TIMEOUT = 60
EQL_CATEGORIES = json.loads(Path(__file__).with_name('eql_categories.json').read_text(encoding='utf-8'))


def eql_category(settings: dict, ad: dict) -> str:
    categories = EQL_CATEGORIES.get(settings.get('serviceCode'), {})
    geos = settings.get('selectedGeos') or []
    geo = str(ad.get('geo') or (geos[0] if len(geos) == 1 else '')).upper()
    geo = {'GB': 'UK', 'USA': 'US', 'ALL': 'EU'}.get(geo, geo)
    category = categories.get(geo)
    if not category and set(categories) == {'EU'}:
        category = categories['EU']
    if not category:
        raise ValueError('EQL_UNSUPPORTED_CATEGORY_OR_AMBIGUOUS_GEO')
    return category


def request_headers(settings: dict) -> dict[str, str]:
    """Build EQL headers from the configured API token."""
    token = str(settings.get('apiKey') or settings.get('eqlApiKey') or '').strip()
    if not token:
        raise ValueError('EQL_API_KEY_REQUIRED')
    if '\r' in token or '\n' in token:
        raise ValueError('EQL_INVALID_API_KEY')
    return {
        'accept': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
    }

VARIABLE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_.]*)\}")


def request_body(settings: dict, ad: dict) -> dict:
    """Build the supplied EQL payload; serviceCode must be an EQL category."""
    service_code = eql_category(settings, ad)
    return {
        'serviceCode': service_code,
        'version': str(settings.get('mode') or '2.0'),
        'title': ad.get('title') or '',
        'price': str(ad.get('price') if ad.get('price') is not None else ''),
        'photo': ad.get('image_url') or '',
        'about': ad.get('description') or ad.get('about') or '',
        'name': settings.get('buyerName') or '',
        'address': settings.get('buyerAddress') or '',
    }


def render_text(text: str, values: dict[str, Any]) -> str:
    """Substitute known fields once; preserve unknown placeholders."""
    def replace(match: re.Match) -> str:
        key = match.group(1)
        if key not in values:
            return match.group(0)
        return "" if values[key] is None else str(values[key])

    return VARIABLE.sub(replace, text)


if __name__ == "__main__":
    product = {
        "product.title": "Bicycle",
        "product.price": "150 EUR",
        "product.condition": "Used",
    }
    print(render_text("Product: {product.title}\nPrice: {product.price}\nCondition: {product.condition}", product))


def generate_link(settings: dict, ad: dict) -> str:
    """Return an HTTP(S) URL. settings contains the selected config; ad the listing."""
    headers = request_headers(settings)
    payload = request_body(settings, ad)
    try:
        with requests.Session() as client:
            client.trust_env = False
            response = client.post(EQL_ENDPOINT, headers=headers, json=payload,
                                   timeout=EQL_TIMEOUT, allow_redirects=False)
            response.raise_for_status()
            result = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise ValueError('LINK_PROVIDER_REQUEST_FAILED') from exc
    if not isinstance(result, dict) or result.get('status') is not True:
        raise ValueError('LINK_PROVIDER_CREATE_FAILED')
    data = result.get('data')
    link = data.get('adUrl') if isinstance(data, dict) else None
    if isinstance(link, str):
        try:
            parsed = urlparse(link)
            if parsed.scheme in ('http', 'https') and parsed.hostname:
                return link
        except ValueError:
            pass
    raise ValueError('LINK_PROVIDER_INVALID_RESPONSE')
