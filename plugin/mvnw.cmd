@ECHO OFF
@REM ----------------------------------------------------------------------------
@REM Apache Maven Wrapper startup batch script
@REM ----------------------------------------------------------------------------

SETLOCAL EnableDelayedExpansion

@REM 固定 Maven 版本
SET "MAVEN_VERSION=3.9.6"
SET "DIST_URL=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/%MAVEN_VERSION%/apache-maven-%MAVEN_VERSION%-bin.zip"

@REM Determine JAVA_HOME
IF NOT "%JAVA_HOME%"=="" GOTO javaHomeSet
FOR /F "tokens=*" %%i IN ('where java 2^>NUL') DO (
    SET "JAVA_EXE=%%i"
    GOTO javaFound
)
ECHO Error: JAVA_HOME is not set and java command not found in PATH.
EXIT /B 1

:javaFound
FOR %%i IN ("%JAVA_EXE%") DO SET "JAVA_BIN=%%~dpi"
SET "JAVA_HOME=!JAVA_BIN:~0,-5!"

:javaHomeSet
SET "JAVA_EXE=%JAVA_HOME%\bin\java.exe"
IF NOT EXIST "%JAVA_EXE%" (
    ECHO Error: JAVA_HOME is set to an invalid directory: %JAVA_HOME%
    EXIT /B 1
)

@REM Set Maven home
SET "MAVEN_HOME=%USERPROFILE%\.m2\wrapper\dists\apache-maven-%MAVEN_VERSION%"
SET "MVN_CMD=%MAVEN_HOME%\bin\mvn.cmd"

@REM Download and extract Maven if needed
IF NOT EXIST "%MVN_CMD%" (
    ECHO ============================================
    ECHO Downloading Maven %MAVEN_VERSION%...
    ECHO ============================================
    
    SET "DOWNLOAD_DIR=%USERPROFILE%\.m2\wrapper\dists"
    IF NOT EXIST "!DOWNLOAD_DIR!" MKDIR "!DOWNLOAD_DIR!"
    
    SET "ZIP_FILE=!DOWNLOAD_DIR!\apache-maven-%MAVEN_VERSION%-bin.zip"
    
    @REM Download using PowerShell
    ECHO Downloading from %DIST_URL%
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DIST_URL%' -OutFile '!ZIP_FILE!'"
    
    IF NOT EXIST "!ZIP_FILE!" (
        ECHO Error: Failed to download Maven
        EXIT /B 1
    )
    
    ECHO Extracting Maven...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '!ZIP_FILE!' -DestinationPath '!DOWNLOAD_DIR!' -Force"
    
    DEL "!ZIP_FILE!"
    
    IF NOT EXIST "%MVN_CMD%" (
        ECHO Error: Failed to extract Maven
        EXIT /B 1
    )
    
    ECHO ============================================
    ECHO Maven %MAVEN_VERSION% installed successfully!
    ECHO ============================================
)

@REM Run Maven
"%MVN_CMD%" %*

ENDLOCAL
