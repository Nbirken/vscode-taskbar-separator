cmake_minimum_required(VERSION 3.10)
project(VSCodeTaskbarWrapper)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Windows-specific compilation
if(WIN32)
    add_executable(code WIN32
        src/main.cpp
    )
    
    # Link Windows libraries for COM and taskbar interfaces
    target_link_libraries(code 
        shell32.lib      # Shell API
        ole32.lib        # COM
        oleaut32.lib     # COM Automation
        advapi32.lib     # Registry API
        propsys.lib      # Property Store
    )
else()
    message(FATAL_ERROR "This project is Windows-only")
endif()
