#!/bin/bash

# 데이터베이스 마이그레이션 스크립트
# 서버에서 안전하게 마이그레이션을 실행합니다.
# 모든 마이그레이션은 idempotent하게 작성되어 있어 여러 번 실행해도 안전합니다.

set -e  # 에러 발생 시 스크립트 중단

echo "🚀 데이터베이스 마이그레이션을 시작합니다..."

# 환경 변수 확인
if [ -z "$DB_HOST" ] || [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
  echo "❌ 에러: 데이터베이스 환경 변수가 설정되지 않았습니다."
  echo "필요한 환경 변수: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD"
  exit 1
fi

echo "📊 데이터베이스 연결 정보:"
echo "  - Host: $DB_HOST"
echo "  - Database: $DB_NAME"
echo "  - User: $DB_USER"

# 마이그레이션 실행
echo "📦 마이그레이션을 실행합니다..."
echo "   (모든 마이그레이션은 idempotent하게 작성되어 있어 안전하게 실행됩니다)"
if bun run db:migrate; then
  echo "✅ 마이그레이션이 성공적으로 완료되었습니다!"
  echo "   데이터베이스가 로컬 개발 환경과 동일한 구조로 동기화되었습니다."
  exit 0
else
  echo "❌ 마이그레이션 실행 중 오류가 발생했습니다."
  echo "   로그를 확인하고 데이터베이스 연결 및 권한을 확인해주세요."
  exit 1
fi
