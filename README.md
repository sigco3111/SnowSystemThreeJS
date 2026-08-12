# 🌨️ SnowSystemThreeJS — 눈 스튜디오 (한국어 한글판)

**Three.js + GLSL 셰이더** 기반의 **절차적 눈 시뮬레이터** 입니다. GPU 인스턴싱으로 그리는 입자형 눈송이, 지면·모델에 누적되는 눈, 얼어붙은 호수, 시네마틱 카메라, 그리고 풀 포스트프로세싱 파이프라인을 한 화면에서 GUI 로 실시간 조작할 수 있습니다. 본 저장소는 `achrefelouafi/SnowSystemThreeJS` 의 **sigco3111 한국어 fork** 입니다 — 모든 컨트롤과 안내문을 한글로 제공하며, `src/i18n.js` 가 한국어/영문 양쪽 키를 모두 보관합니다.

---

## 🌐 라이브 데모

**👉 https://sigco3111.github.io/SnowSystemThreeJS/**

브라우저에서 그대로 실행 — 별도 빌드 없이 풀 인터랙티브 데모를 바로 확인하실 수 있습니다.

---

## 📚 저장소

- 🇰🇷 **한국어 fork**: https://github.com/sigco3111/SnowSystemThreeJS
- ⭐ **원본 저장소** (achrefelouafi): https://github.com/achrefelouafi/SnowSystemThreeJS
- 🌐 **라이브 데모**: https://sigco3111.github.io/SnowSystemThreeJS/

---

## ✨ 주요 기능

### ❄️ 절차적 눈 시뮬레이션

- **공중 눈송이** — GPU 인스턴싱으로 1만~수만 개 입자를 동시에 렌더링. 밀도 / 낙하 속도 / 크기 / 흔들림 / 색상 / 높이 슬라이더로 실시간 조정.
- **지면 누적** — `MeshStandardMaterial` 변위맵 + 정규화 셰이더로 실제처럼 울퉁불퉁한 눈 표면 생성. 표류 스케일 / 범위 / 융해선 부드러움 / 색상 / 러프니스 / 깊이 / 범프 / 반짝임 13개 컨트롤.
- **모델 누적** — 임포트한 GLB 의 위쪽 면에만 눈이 자동으로 누적. 머티리얼 기반 분할로 모델 형태 보존.

### 🧊 얼어붙은 호수

- **모양과 크기** — 반경 / 중심 / 불규칙성 / 엽(lobes) / 모양 시드 슬라이더로 자연스러운 호수 윤곽 생성. `🎲 무작위화` 버튼으로 즉시 새 모양.
- **깊이와 바닥** — 분지 깊이 / 바닥 색상.
- **얼음 표면** — 불투명도 / 얕은 색상 / 깊은 물 색상 / 반사 색상 / 프레넬 / 태양 글린트 / 표면 거칠기 / 스케일 9개 컨트롤.
- **균열 · 서리 · 거품** — 균열 양/스케일, 기슭 서리/너비, 거품 양/밀도 6개 디테일 컨트롤.

### 🚗 모델

- **프리셋 모델** — Rusty Car / Porsche 911 두 종 기본 제공.
- **GLB 임포트** — `.glb` 파일을 직접 업로드해서 어떤 모델에도 눈을 입힐 수 있음.
- **트랜스폼** — 스케일 / 위치 XYZ / Y축 회전 슬라이더.

### 🎬 시네마틱

- **카메라** — 자동 회전 (궤도) / 회전 속도 / FOV (초점 거리) / 레터박스 4개 컨트롤.
- **피사계 심도 (DoF)** — DoF 켜기 / 초점 거리 / 조리개 / 최대 블러 4개 컨트롤. 드래그 중에는 초점 평면이 깜빡여 포커스 위치를 시각적으로 안내.
- **효과** — 블룸 (강도/반경/임계값) / 필름 그레인 / 비네트 / 색수차 / 대비 / 채도 8개 컨트롤.

### 💡 라이팅 + 환경

- **노출** + **키 / 필 / 림** 3점 조명 + **환경광 / IBL** + **안개** (켜기/밀도).
- 시네마틱 청색 액센트 (`--accent: #8fcfff`) 로 통일된 톤.

### 🎨 한국어 UI

- `src/i18n.js` 가 **110+ 한국어/영문 키** 를 모두 보관.
- GUI 폴더 / 컨트롤 / 안내문 전부 한국어로 통일.
- `setLanguage('en')` 으로 영문 토글 가능 (현재 자동 = 한국어).

---

## 🛠️ 기술 스택

| 영역 | 사용 기술 |
|---|---|
| **렌더러** | Three.js 0.185 + WebGL2 |
| **빌드** | Vite 6.4 |
| **UI 컨트롤** | lil-gui 0.20 |
| **카메라 컨트롤** | OrbitControls (Three.js addons) |
| **환경맵** | RoomEnvironment (절차적 IBL) |
| **셰이더** | GLSL ES 3.0 (사용자 정의 정점/프래그먼트) |
| **모델** | GLTFLoader (.glb) |
| **오디오** | WebAudio (snowfall ambient) |

---

## 🚀 로컬 실행

```bash
# 1. 저장소 클론
git clone https://github.com/sigco3111/SnowSystemThreeJS.git
cd SnowSystemThreeJS

# 2. 의존성 설치 (pnpm 권장)
pnpm install

# 3. 개발 서버 (http://localhost:5174)
pnpm dev

# 4. 프로덕션 빌드
pnpm build

# 5. 빌드 결과 미리보기
pnpm preview
```

빌드 산출물은 `dist/` 폴더에 생성되며, GitHub Pages 와 1:1 로 동일하게 작동합니다.

---

## 📁 프로젝트 구조

```
SnowSystemThreeJS/
├─ src/
│  ├─ main.js          # 메인 엔트리 — GUI / 씬 셋업 / 렌더 루프
│  ├─ i18n.js          # 🇰🇷 KO + 🇺🇸 EN 키 (110+)
│  ├─ snow.js          # GPU 인스턴싱 눈송이 시스템
│  ├─ lake.js          # 얼어붙은 호수 (절차적 셰이프)
│  ├─ model.js         # GLB 로더 + 머티리얼 기반 눈 누적
│  ├─ snowAudio.js     # snowfall 앰비언트 오디오
│  ├─ postfx.js        # Bloom + DoF + Color Grade 포스트프로세싱
│  └─ vite.config.js   # base: '/SnowSystemThreeJS/' (GitHub Pages 경로)
├─ public/             # 정적 자산 (Vite 가 dist 로 복사)
│  ├─ Material_1/      # Asphalt025C PBR 텍스처 5종
│  ├─ Material_2/      # Asphalt024A PBR 텍스처 5종
│  ├─ old_rusty_car_2.glb
│  ├─ porsche_911.glb
│  └─ snowfall.mp3
├─ index.html          # <html lang="ko"> + 한글 credit
└─ README.md           # 본 파일
```

---

## 🎮 사용 방법

1. **궤도 카메라** — 마우스 드래그 (또는 터치 드래그) 로 카메라 회전
2. **줌** — 마우스 휠 (또는 핀치)
3. **GUI 조작** — 우측 상단 패널에서 모든 컨트롤 조정
4. **GLB 임포트** — 🚗 모델 폴더 → "📂 GLB 임포트…" 버튼
5. **즉시 번개** — ⚡ 즉시 번개 버튼으로 폭설 한 번 트리거

---

## 🌐 다국어 토글

기본은 한국어. 콘솔에서 영문으로 전환:

```javascript
import { setLanguage } from './src/i18n.js';
setLanguage('en');
// 이후 모든 GUI 라벨이 영문으로 갱신됨
```

새 GUI 컨트롤을 추가할 때는 `src/i18n.js` 의 `KO` / `EN` 양쪽에 키를 추가하면 양쪽 언어에 동시 반영됩니다.

---

## 🎯 한국어 fork 컬렉션 (sigco3111)

같은 작성자 `achrefelouafi` 의 다른 한국어 fork 들:

| # | 라이브 데모 | GitHub |
|---|---|---|
| 1 | https://waterthreejs.vercel.app | sigco3111/WaterThreeJS |
| 2 | https://basicproceduralbuilding.vercel.app | sigco3111/BasicProceduralBuilding |
| 3 | https://polegeneratortwothreejs.vercel.app | sigco3111/PoleGeneratorThreeJS |
| 4 | https://bookcasethreejs.vercel.app | sigco3111/BookcaseThreeJS |
| 5 | https://vegetationgeneratortwothreejs.vercel.app | sigco3111/VegetationGeneratorThreeJS |
| 6 | https://buildinggeneratortwothreejs.vercel.app | sigco3111/BuildingGeneratorThreeJS |
| 7 | https://grasssystemthreejs.vercel.app | sigco3111/GrassSystemThreeJS |
| 8 | https://rainsystemthreejs.vercel.app | sigco3111/RainSystemThreeJS |
| 9 | **https://sigco3111.github.io/SnowSystemThreeJS/** ← 본 저장소 |

모두 동일한 풀폴드 + 풀 한글화 + Vite + i18n.js 패턴을 공유합니다.

---

## 📜 라이선스

원본 저장소와 동일 — **MIT License** ([LICENSE](./LICENSE) 참조).

원본 저작권: © achrefelouafi
한국어 fork 및 i18n.js 추가: © sigco3111
