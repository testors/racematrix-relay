# RaceMatrix Relay

ESP32·스마트폰 GPS와 현장 daemon 사이의 전용 릴레이. **Node.js 24**, 단일 프로세스,
SQLite 장치 등록부를 사용한다. Circuit의 CAN 로거 경로는 그대로 두고 이 서비스는
GPS 전용 UDP uplink와 플래그·레이아웃 downlink를 담당한다.
하나의 릴레이에 여러 서킷의 Ops/daemon 페어를 연결할 수 있다. 각 daemon은 자기 서킷의
현재 선택된 현장 트랙을 자동 발행하고, 이동식 GPS 장치는 위치로 서킷을 선택한다.

```text
L76K → ESP32 ── LTE / UDP 8677 ──→ Relay ── WSS ──→ daemon → Ops
          └── HTTPS 인증 / WSS ←────┘                 │
                    플래그·레이아웃 ←──── WSS ────────┘
                                           현장 어댑터의 관측 상태
```

ESP32와 daemon 모두 먼저 외부로 연결한다. 현장 네트워크의 inbound UDP/포트 포워딩은 필요 없다.
레이아웃은 해시가 바뀔 때 다운로드하고, 플래그는 변경 시 전체 상태를 전송한다.
변경이 없어도 1초 간격의 작은 lease 메시지로 현장 연결 생존을 확인한다.
플래그는 마지막으로 확인한 현장 생존 시각부터 최대 3초만 유효하다.

## 설치 및 로컬 확인

```sh
npm ci
npm run check
npm test
# sibling racematrix-daemon 체크아웃까지 포함한 실제 UDP/WSS 통합 테스트
npm run test:daemon
```

통합 테스트는 임시 SQLite DB, 임시 daemon 설정, loopback 임의 포트를 사용한다.
운영 서비스나 외부 현장 장비에 연결하지 않는다. 다른 위치의 daemon은
`RACEMATRIX_DAEMON_REPO=/absolute/path`로 지정한다.

## 서킷·장치 등록

서킷과 해당 daemon의 발행 자격을 최초 한 번 등록한다. 레이아웃 파일은 자동 모드에서 필요 없다.
각 서킷의 daemon에는 서로 다른 `circuitId`와 해당 gateway credential을 설정한다.
레이아웃 좌표는 **[위도 E7, 경도 E7]**다. 서킷당 최대 48개 구간/512개 좌표/32KiB.
`path`는 주행선과 폭, `polygon`은 구간 면적이다. 서로 겹치거나 현재 GPS가 벗어나면 장치는 구간을 unknown으로 처리한다.

```sh
node bin/relay.js circuit-create --circuit-id 1 --name 'Circuit A'
node bin/relay.js circuit-create --circuit-id 2 --name 'Circuit B'
mkdir -m 700 private
node bin/relay.js device-provision --hardware-uid esp32:aabbccddeeff \
  --output private/gps-7.json
node bin/relay.js gateway-provision --circuit-id 1 --name 'Daemon A' \
  --publish --output private/gateway-a.json
node bin/relay.js gateway-provision --circuit-id 2 --name 'Daemon B' \
  --publish --output private/gateway-b.json
node bin/relay.js list
```

`examples/daemon-adapter.json`의 자동 설정과 각 gateway JSON을 daemon 설정에 사용한다.
`device-provision`에서 `--circuit-id`를 생략하면 GPS 자동 선택 모드다. 기존 고정 모드는
`--circuit-id ID [--number 7]`로 유지할 수 있다. 기존 DB는 자동 마이그레이션하되 고정 배정은 보존한다.
등록은 신뢰된 서버의 CLI에서만 가능하다. ID만 알고 공개 API로 장치를 가져가는 경로는 없다.
하드웨어 ID는 eFuse MAC에 따른 식별자이고 인증은 별도의 장치별 비밀키로 수행한다.
새 운영용 ID(`source_public_uid`)는 `SRC-7K3M9Q`처럼 접두사 포함 10자다.
6자리 난수는 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`의 32개 문자로 생성하고,
릴레이 등록 DB 전체에서 중복을 검사해 재생성한다. 폐기한 기기의 ID도 재사용하지 않는다.
기존 긴 ID와 Circuit에서 가져온 ID는 그대로 유지한다. ID 길이는 인증키 강도와 관계없다.
같은 하드웨어를 다시 등록하면 기존 UID/키를 재사용한다. 명시적 `--rotate`는 키를 바꾸며 USB 재등록이 필요하다.
기존 출력 파일은 덮어쓰지 않는다. credentials는 stdout에 출력하지 않고 0600 파일로 저장한다.

USB 작업 PC에서 firmware와 NVS를 기록한다. 서버와 USB PC가 같으면
`racematrix-gps/tools/provision.py --relay-repo ...`로 등록/기록을 함께 할 수 있다.
서로 다른 PC라면 위 장치 credential JSON을 USB PC로 안전하게 전달한다.

```sh
cd ../racematrix-gps
python tools/provision.py --port /dev/ttyUSB0 --credentials /secure/gps-7.json \
  --base-url https://relay.example.com --udp-host udp.relay.example.com --apn internet
```

등록된 기기는 전원만 켜면 자동 인증한다. `source_public_uid`를 Ops 참가 차량의
**GPS/CAN Device ID**에 넣는다. 장치 인증과 차량 엔트리 배정은 별개이며, 개인 플래그를 받으려면
Relay의 번호도 실제 차량 번호와 일치해야 한다. 이동식 장치는 아래 `device-number`로 서킷별 번호를
배정하며, 다른 서킷의 개인 플래그 번호를 이어받지 않는다. 현재 Ops 참가 엔트리와 번호는 자동 동기화하지 않는다.

```sh
# 차량/서킷 변경: 기기 키와 source UID는 보존, 기존 세션은 무효화
node bin/relay.js device-bind --source-uid SRC-... --circuit-id 1 --number 8
# 기존 고정 장치를 GPS 자동 선택 모드로 전환
node bin/relay.js device-bind --source-uid SRC-... --auto
# 자동 선택 장치의 서킷별 개인 플래그 번호 (생략하면 해당 서킷 번호 해제)
node bin/relay.js device-number --source-uid SRC-... --circuit-id 1 --number 7
node bin/relay.js device-number --source-uid SRC-... --circuit-id 2 --number 42
# 새 gateway에 발행 권한 이전: 서킷당 단 하나
node bin/relay.js publisher-bind --circuit-id 1 --credential-uid gateway_...
node bin/relay.js revoke --credential-uid cred_...
```

권한 변경은 활성 연결에 약 1초 내 반영된다. ESP32의 다음 HTTPS 갱신(정상 주기 약 60초)에서 새 할당을 받는다.
공장 NVS에 Relay 서킷 ID를 고정하지 않으므로 변경 시 USB 재기록이 필요 없다.

## Android·iOS 스마트폰 등록

`../racematrix-mobile` 앱도 같은 UDP 위치/WSS 플래그 채널을 사용한다.
운영자가 발급한 초대 정보를 앱에 한 번 입력하면 이후 자동 인증한다.

```sh
node bin/relay.js mobile-invite --base-url https://relay.example.com \
  --name 'Phone 7' --output private/phone-7.json
```

기본 30분 유효한 32자 등록 코드는 임의의 192비트 값이다. `--ttl-minutes 60`,
`--udp-port 8677`로 변경할 수 있다. `--circuit-id`를 생략하면 GPS 자동 배정,
지정하면 해당 서킷 고정이다. 앱은 주소와 코드를 입력하거나 발급 JSON을 붙여넣는다.
코드는 한 설치의 nonce에만 결합되며, HTTPS 응답이 유실되었을 때 같은 설치만
만료 전 재시도할 수 있다. 장기 키는 발급 파일 대신 앱의 보안 저장소로 전달한다.
장치 재바인딩/키 회전/폐기로 generation이 바뀌면 기존 초대도 무효화된다.

공개 활성화 API가 ID만으로 등록을 허용하지는 않는다. 초대 생성은 신뢰된 CLI에서만 가능하다.
스마트폰의 등록 식별자는 `mobile:<128-bit random>`, 운영용 ID는 ESP32와 같은 10자리다.
IMEI/전화번호는 필요 없다. 차량 엔트리의 GPS/CAN ID 연결과 `device-number` 개인 플래그
번호 설정은 ESP32와 동일하다. 기존 daemon/Circuit CAN 로거 프로토콜 변경은 필요 없다.

폰은 약 1Hz로 최신 위치만 보낸다. 서킷 후보의 연속 위치 간격은 최대 2초여서
1Hz 지터를 허용하지만, GPS/플래그의 기존 2초/3초 만료 규칙은 유지한다.
세션/hello/assignment에 현재 `circuit_name`/`circuitName`도 제공한다.

## 자동 레이아웃과 GPS 서킷 선택

Ops에서 선택한 현장 트랙은 daemon의 MYLAPS X2 Link `trackConfig.current` 관측 결과로 확정된다.
자동 모드(`syncLayout: true`)는 동일 어댑터의 현재 주행선과 플래그 구간 경로를 읽어 WSS로 발행한다.
Ops 또는 Circuit 서버를 릴레이가 폴링하지 않는다. 선택 완료·구간 변경·재접속 때 현재 전체 레이아웃을
발행하고, 평소에는 1초 간격으로 생존 확인만 보낸다. 구간 ID 매핑과 레이아웃 해시는 자동으로 맞춘다.
주행구간 폭은 현장 트랙 모델 값을 사용하고, 값이 없으면 20m다. 중간 좌표는 최대 0.5m 오차로
단순화하되 구간 끝점은 보존하며, 512점/32KiB 한도를 넘거나 구간 좌표가 없으면 발행을 중단한다.

장치가 보낸 인증된 최신 GPS가 **활성 서킷 하나의 주행선 주변 150m 안**에 있으면 후보가 된다.
연속 세 위치가 400ms 이상 같은 서킷을 가리킬 때 배정하고 해당 daemon으로 GPS를 전달한다.
`circuitRadiusM`은 25~500m로 설정할 수 있다. 주행선이 없으면 구간 경로들의 150m 범위 합집합을 사용한다.
둘 이상 겹치거나 서킷 밖, GPS 불명/만료이면 미배정(`circuitId: 0`)으로 전환한다.
가장 가까운 서킷을 임의로 고르지 않으며 수동 고정 모드도 사용할 수 있다.

현장 연결이 끊기거나 트랙 전환 중이면 레이아웃을 철회한다. 생존 확인 없이 5초가 지나거나 발행
daemon이 끊어져도 자동 선택 대상에서 제외한다. 재시작 후 저장된 레이아웃만으로 자동 배정하지 않는다.
ESP32는 WSS의 `circuit.assignment`로 서킷/레이아웃 변경을 받아 이전 플래그를 즉시 무효화하고,
해당 레이아웃을 HTTPS로 검증·다운로드한 후 현재 플래그를 다시 받는다. UDP 인증 세션은 계속 쓸 수 있다.
자동 선택에는 이 메시지를 지원하는 최신 `racematrix-gps` 펌웨어가 필요하다.

## daemon 연결 및 플래그

`racematrix-daemon/plugins/racematrix-relay`가 자동 발견된다. 설정 예시는
[examples/daemon-adapter.json](examples/daemon-adapter.json), 상세는 sibling
[plugin README](../racematrix-daemon/plugins/racematrix-relay/README.md)를 참고한다.
기본 GPS 수신만 사용할 때는 `publishFlags: false`면 된다.

자동 발행에는 등록 시 `--publish`, `syncLayout: true`, `publishFlags: true`,
`flagSourceAdapterId`가 필요하다. 현재 MYLAPS X2 Link의
`control.flag.state.observed`를 지원한다. 운영자가 누른 명령이나 Ops의 선언 상태를 실제 관측 상태로 간주하지 않는다.
full-course / zone / personal 범위를 구분하며 personal은 등록된 차량 번호에만 전송한다.
구간 패널의 offline/degraded 상태는 unknown으로 보낸다.

현장 어댑터의 최근 수신 시각, 인증 상태, 선택된 트랙을 계속 확인한다.
소켓이 열려 있어도 현장 프레임이 2초 이상 끊기면 유효한 플래그 발행을 중단한다.
Relay/daemon 재시작, 권한 변경, 레이아웃 변경, lease 만료 때 마지막 녹색을 임의로 복구하지 않는다.
ESP32는 네트워크 작업과 별개인 HMI task에서 만료를 검사한다.
LCD 하드웨어 드라이버는 `rm_hmi_update()`를 구현해 붙인다. 현재 기본 구현은 상태 변경을 직렬 로그에 출력한다.

## Circuit 자료 재사용

수동 고정 모드는 `syncLayout: false`와 `layoutHash`, `sourceTrackName`, `zoneBindings`를 지정한다.
`circuit-put --layout FILE` 또는 아래 import로 레이아웃을 등록한다. `examples/layout.json`은 테스트용이다.
Circuit은 선택적인 카탈로그/레이아웃 원본이다. 릴레이 실행에는 Rails/Redis/Circuit API가 필요 없다.
identity가 포함된 Circuit layout 및 operations overlay export를 가져올 수 있다.
`base_circuit.layout_id/layout_content_hash` 참조 일치를 확인하고 **새 compact layout SHA-256**을 계산한다.
이 작업은 로컬 관리자가 선택한 export를 신뢰하며 Circuit 원본 해시의 재계산 검증을 대신하지 않는다.

```sh
node bin/relay.js circuit-import --circuit-id 1 --name 'Venue' \
  --base-layout /exports/layout.json --overlay /exports/operations-overlay.json \
  --zone-ids zone_x2_sector_3,zone_x2_sector_4
```

overlay의 `operational_zones` 중 명시적인 `flag_zone`만 읽는다.
`polygon`, `path`/`polyline`의 lat/lng 점, `track_range`의 from_m/to_m를 지원한다.
track_range는 base `track_points`의 거리로 잘라 경로로 변환한다.
timing sector나 geometry가 없는 운영 그룹으로 주행 구간을 추정하지 않는다.
구간을 모두 고르려면 `--zone-ids`를 생략하며, 선택 구간에 geometry가 없으면 등록에 실패한다.
`x2-sector-3 → zone_x2_sector_3` 같은 ID 차이는 daemon의 `zoneBindings`에 명시한다.

기존 Circuit GPS credential을 `device-provision --import-credential /secure/circuit-gps.json`으로
가져오면 source UID와 키를 보존할 수 있다. 장치의 서버 주소는 새 Relay로 다시 기록한다.
기존 CAN type 1 로거는 계속 Circuit에 연결한다. 이 Relay는 GPS type 2만 받는다.

## 실행·배포

로컬 개발은 `npm start`로 HTTP 127.0.0.1:8787 / UDP 8677을 연다.
운영은 공인 서버에 HTTPS/WSS 443과 UDP 8677을 연다. HTTP 전용 CDN/프록시는 UDP를 전달하지 않는다.
UDP 호스트는 Relay가 직접 받는 주소를 사용한다.

- Docker: [compose.yaml](compose.yaml)과 [deploy/Caddyfile](deploy/Caddyfile). `RELAY_DOMAIN`을 실제 DNS 이름으로 지정하고 `docker compose up -d --build`.
  HTTP 8787은 컨테이너 네트워크 내부에서만 접근한다. 영구 등록부는 `relay_data` volume이다.
  Caddy의 기본 reverse proxy는 WebSocket upgrade를 지원한다 ([공식 문서](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)).
- 호스트 설치: Node 24와 `npm ci --omit=dev`, [deploy/racematrix-relay.service](deploy/racematrix-relay.service).
  Caddy/nginx에서 loopback 8787로 HTTPS/WSS를 프록시한다.
- 직접 TLS: `RELAY_TLS_CERT`, `RELAY_TLS_KEY`를 함께 지정한다. 환경 변수는 아래 표 참고.

| 변수 | 기본값 / 의미 |
| --- | --- |
| `RELAY_HOST`, `RELAY_PORT` | `127.0.0.1`, `8787` |
| `RELAY_UDP_HOST`, `RELAY_UDP_PORT` | `0.0.0.0`, `8677` |
| `RELAY_DATA_DIR` | `./data`; CLI도 동일 |
| `RELAY_TLS_CERT`, `RELAY_TLS_KEY` | PEM 파일 경로, 직접 TLS 사용 시 |
| `RELAY_BEHIND_TLS_PROXY` | `1`일 때만 공용 bind의 내부 평문 HTTP 허용 |

Docker 등록 명령은 실행 중인 컨테이너 안에서 수행한다. 예: `docker compose exec relay node bin/relay.js list`.
레이아웃 파일과 새 credential 출력 디렉터리는 컨테이너에 복사/마운트하여 CLI 경로로 지정한다.
호스트 CLI로 등록할 때도 **실행 서비스와 같은 data directory**를 지정한다.

`GET /healthz`는 프로세스/UDP 바인딩 상태다. 세션/트래픽은 메모리에만 있고 재시작하면 재인증한다.
위치 이력과 플래그는 SQLite에 저장하지 않는다. 등록부는 `relay.sqlite*`와 `master.key`를 함께 보존한다.
백업은 SQLite의 일관된 backup 또는 서비스 정지 후 디렉터리 복사로 수행하고 키 파일도 함께 보관한다.
여러 프로세스/서버로 단순 복제하면 세션·UDP·WSS 소유자가 달라진다. 현재 배포 단위는 단일 인스턴스다.
서비스 수용량은 실차/부하 시험으로 확인해야 하며 코드의 최대 연결 수가 처리 성능 보증은 아니다.

## 최신값 정책과 검증 범위

UDP는 장치별 sequence/UTC를 검사하며 2초를 넘긴 측정값, 중복, 역순, 잘못된 HMAC을 버린다.
발신 WSS 대기열에는 장치마다 최신 위치 하나만 둔다. 느린 TCP 연결은 끊어 과거 위치의 누적 재생을 막는다.
daemon도 도착 시 측정 나이/순서를 다시 확인한다. daemon의 기존 timing/capture durable spool 계약은 변경하지 않는다.
클라우드와 daemon의 UTC 시계는 동기화한다.

`npm test`는 인증/재전송 방지/등록/격리/UDP/flag lease/재접속/느린 소비자/레이아웃을 검증한다.
통합 테스트는 실제 daemon runtime과 소켓을 사용한다. firmware는 ESP32 cross build 및 호스트 C 테스트를 수행한다.
실물 A7670G/L76K, 이동 중 LTE 품질, 실제 LCD 표시는 별도 실차 검증 대상이다.
프로토콜 상세: [docs/protocol.md](docs/protocol.md).
