import json
import importlib
import sys


def main():
    if sys.argv[1:] == ['--self-test']:
        for provider in ('eql', 'kartatai'):
            importlib.import_module(provider)
        print(json.dumps({'ready': True}))
        return
    payload = json.load(sys.stdin)
    provider = payload['settings']['provider']
    if provider not in ('eql', 'kartatai'):
        raise ValueError('Unsupported provider')
    module = importlib.import_module(provider)
    result = module.generate_link(payload['settings'], payload['ad'])
    print(json.dumps({'link': result}, ensure_ascii=False))


if __name__ == '__main__':
    main()
